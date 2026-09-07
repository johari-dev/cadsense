import * as NodeServices from "@effect/platform-node/NodeServices";
import { OnshapeRateLimitError } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { layerTest } from "../config.ts";
import * as Store from "../cad/CadSnapshotStore.ts";
import {
  OnshapeConnections,
  type OnshapeJsonRequest,
  type OnshapeReadRequest,
} from "./OnshapeConnections.ts";
import * as Acquisition from "./OnshapeSnapshotAcquisition.ts";
import * as SyncState from "./OnshapeSyncState.ts";
import {
  bulkFixture,
  bulkInput,
  bulkMicroversion,
  translationDone,
  encodeFixture,
} from "./testFixtures/bulkExport.ts";

const unused = () => Effect.die("Unexpected operation");
const makeHarness = (count: number) =>
  Effect.gen(function* () {
    const fixture = bulkFixture(count);
    const requests: Array<OnshapeReadRequest & { method?: string }> = [];
    const options = {
      failDownload: false,
      failPublish: false,
      changedDuringExport: false,
      activeTranslation: false,
      omitBody: false,
    };
    const statusRead = yield* Deferred.make<void>();
    let pins = 0;
    const store = yield* Store.make.pipe(
      Effect.provideService(Store.CadDiskSpace, {
        availableBytes: () => Effect.succeed(10 * 1024 ** 3),
      }),
    );
    const connections = OnshapeConnections.of({
      list: unused,
      create: unused,
      rename: unused,
      remove: unused,
      replaceCredentials: unused,
      readJson: (request: OnshapeJsonRequest) =>
        Effect.gen(function* () {
          requests.push(request);
          if (request.path.endsWith("currentmicroversion"))
            return {
              microversion:
                ++pins > 1 && options.changedDuringExport
                  ? "999999999999999999999999"
                  : bulkMicroversion,
            };
          if (request.method === "POST") return translationDone;
          if (request.path.includes("/translations/")) {
            yield* Deferred.succeed(statusRead, undefined);
            return options.activeTranslation
              ? { ...translationDone, requestState: "ACTIVE" }
              : translationDone;
          }
          if (request.path.includes("/assemblies/")) return fixture.definition;
          return yield* Effect.die("Unexpected API request");
        }),
      readBinary: (request) =>
        Effect.gen(function* () {
          if (request.beforeRequest) yield* request.beforeRequest;
          requests.push(request);
          if (options.failDownload) return yield* new OnshapeRateLimitError({});
          if (request.beforeChunk) yield* request.beforeChunk(fixture.bytes.length);
          const bytes =
            options.omitBody && request.path.includes("/externaldata/")
              ? new TextEncoder().encode(
                  encodeFixture({
                    ...fixture.gltf,
                    nodes: fixture.gltf.nodes.map((node, i) =>
                      i === count * 2 && "children" in node
                        ? { ...node, children: node.children.slice(1) }
                        : node,
                    ),
                  }),
                )
              : fixture.bytes;
          return { bytes, contentType: "model/gltf+json" };
        }),
    });
    // Rebuild both services for every attempt to test actual on-disk recovery, not an in-memory memo.
    const acquire = () =>
      Effect.gen(function* () {
        const syncState = yield* SyncState.make.pipe(
          Effect.provideService(Store.CadSnapshotStore, store),
        );
        const acquisition = yield* Acquisition.make.pipe(
          Effect.provideService(OnshapeConnections, connections),
          Effect.provideService(SyncState.OnshapeSyncState, syncState),
          Effect.provideService(Store.CadSnapshotStore, {
            ...store,
            publish: (manifest) =>
              options.failPublish
                ? Effect.fail(new Store.CadSnapshotStoreError({ reason: "unavailable" }))
                : store.publish(manifest),
          }),
        );
        return yield* acquisition.acquire(bulkInput);
      });
    return { acquire, requests, options, statusRead };
  });
const harness = <A, E, R>(
  use: (h: Effect.Success<ReturnType<typeof makeHarness>>) => Effect.Effect<A, E, R>,
  count = 400,
) =>
  makeHarness(count).pipe(
    Effect.flatMap(use),
    Effect.provide(
      layerTest(process.cwd(), { prefix: "onshape-bulk-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

describe("bulk snapshot acquisition", () => {
  it.effect("fetches absent source bodies at their pinned version before publishing", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.options.omitBody = true;
          const manifest = yield* h.acquire();
          assert.lengthOf(manifest.assets, 2);
          const fallback = h.requests.filter((request) => request.path.includes("/partid/"));
          assert.lengthOf(fallback, 1);
          assert.include(fallback[0]!.path, "/v/777777777777777777777777/");
          assert.include(fallback[0]!.query, "linkDocumentId=");
          assert.include(fallback[0]!.path, "/partid/part-0/gltf");
        }),
      2,
    ),
  );
  it.effect(
    "downloads 400 distinct parts in five calls and unchanged sync uses one revision check",
    () =>
      harness((h) =>
        Effect.gen(function* () {
          const first = yield* h.acquire();
          assert.lengthOf(first.parts, 400);
          assert.lengthOf(first.assets, 400);
          assert.lengthOf(h.requests, 5);
          assert.lengthOf(
            h.requests.filter((request) => request.path.includes("/partid/")),
            0,
          );
          const post = h.requests.find((request) => request.method === "POST");
          assert.isDefined(post);
          const second = yield* h.acquire();
          assert.equal(second.snapshotId, first.snapshotId);
          assert.lengthOf(h.requests, 6);
        }),
      ),
  );
  it.effect("resumes a failed download without another export or definition request", () =>
    harness((h) =>
      Effect.gen(function* () {
        h.options.failDownload = true;
        const error = yield* h.acquire().pipe(Effect.flip);
        assert.equal(error._tag, "OnshapeRateLimitError");
        const previousRequests = h.requests.length;
        h.options.failDownload = false;
        const manifest = yield* h.acquire();
        assert.lengthOf(manifest.parts, 400);
        assert.equal(h.requests.length - previousRequests, 4);
        assert.lengthOf(
          h.requests.filter((request) => request.method === "POST"),
          1,
        );
      }),
    ),
  );
  it.effect("reuses the downloaded bundle after publication fails", () =>
    harness((h) =>
      Effect.gen(function* () {
        h.options.failPublish = true;
        yield* h.acquire().pipe(Effect.flip);
        const previousRequests = h.requests.length;
        h.options.failPublish = false;
        yield* h.acquire();
        assert.equal(h.requests.length - previousRequests, 1);
      }),
    ),
  );
  it.effect("rejects workspace changes before downloading geometry", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.options.changedDuringExport = true;
          const error = yield* h.acquire().pipe(Effect.flip);
          assert.equal(error._tag, "OnshapeExportError");
          assert.equal("reason" in error ? error.reason : null, "revision-changed");
          assert.lengthOf(h.requests, 4);
        }),
      2,
    ),
  );
  it.effect("bounds status polling and preserves the job for the next explicit sync", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.options.failDownload = true;
          yield* h.acquire().pipe(Effect.flip);
          h.options.failDownload = false;
          h.options.activeTranslation = true;
          const fiber = yield* h.acquire().pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(h.statusRead);
          yield* TestClock.adjust("15 minutes");
          const error = yield* Fiber.join(fiber);
          assert.equal(error._tag, "OnshapeExportError");
          assert.equal("reason" in error ? error.reason : null, "translation-pending");
          assert.lengthOf(
            h.requests.filter((request) => request.path.includes("/translations/")),
            24,
          );
          h.options.activeTranslation = false;
          yield* h.acquire();
          assert.lengthOf(
            h.requests.filter((request) => request.method === "POST"),
            1,
          );
        }),
      2,
    ),
  );
});
