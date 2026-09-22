import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OnshapeAnnualQuotaExceededError,
  OnshapeInsufficientPermissionsError,
  OnshapeInvalidCredentialsError,
  OnshapeNetworkError,
  OnshapeRateLimitError,
  OnshapeResponseError,
  type OnshapeConnectionError,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import { normalizeCadGeometry } from "../cad/CadGeometry.ts";
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
  encodeFixture,
  translationDone,
} from "./testFixtures/bulkExport.ts";
import { threeMfArchive, threeMfXml } from "./testFixtures/threeMf.ts";

const decodeMaterials = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      materials: Schema.Array(
        Schema.Struct({
          alphaMode: Schema.optionalKey(Schema.String),
          doubleSided: Schema.optionalKey(Schema.Boolean),
          pbrMetallicRoughness: Schema.Struct({ baseColorFactor: Schema.Array(Schema.Number) }),
        }),
      ),
    }),
  ),
);
const unused = () => Effect.die("Unexpected operation");
const makeHarness = (count: number, multipleStudios = false) =>
  Effect.gen(function* () {
    const fixture = bulkFixture(count);
    const metadata = fixture.metadata;
    if (multipleStudios) {
      for (let i = 0; i < count; i++) {
        const elementId = i % 2 === 0 ? "888888888888888888888888" : "999999999999999999999999";
        fixture.definition.parts[i]!.elementId = elementId;
        fixture.definition.rootAssembly.instances[i]!.elementId = elementId;
        metadata[i]!.elementId = elementId;
      }
    }
    const assemblyMetadata = () => ({
      bomSource: {
        document: { id: bulkInput.source.documentId },
        element: { id: bulkInput.root.elementId, configuration: "default" },
        documentMicroversion: { id: bulkMicroversion },
      },
      rows: fixture.definition.parts.map((part, i) => ({
        itemSource: {
          documentId: part.documentId,
          elementId: part.elementId,
          wvmType: "v",
          wvmId: part.documentVersion,
          configuration: part.configuration,
          fullConfiguration: part.fullConfiguration,
          distinctConfigurations: [] as string[],
          partId: part.partId,
        },
        headerIdToValue: {
          "57f3fb8efa3416c06701d60d": metadata[i]!.name,
          "57f3fb8efa3416c06701d60c": metadata[i]!.appearance,
        } as Record<string, unknown>,
      })),
    });
    const bulkMetadata = {
      failure: undefined as OnshapeConnectionError | undefined,
      change: (_response: ReturnType<typeof assemblyMetadata>) => {},
    };
    const requests: Array<OnshapeReadRequest & { method?: string }> = [];
    const options = {
      failDownload: false,
      failPublish: false,
      changedDuringExport: false,
      activeTranslation: false,
      activeSubmission: false,
      omitBody: false,
      omitTwoBodies: false,
      batchFailure: undefined as OnshapeResponseError | undefined,
      batchMissingPart: false,
    };
    const statusRead = yield* Deferred.make<void>();
    const pollScheduled = yield* Deferred.make<Duration.Duration>();
    const clock = yield* Clock.Clock;
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
          if (request.method === "POST") {
            return options.activeSubmission
              ? { ...translationDone, requestState: "ACTIVE" }
              : translationDone;
          }
          if (request.path.includes("/translations/")) {
            yield* Deferred.succeed(statusRead, undefined);
            return options.activeTranslation
              ? { ...translationDone, requestState: "ACTIVE" }
              : translationDone;
          }
          if (request.path.endsWith("/bom")) {
            if (bulkMetadata.failure) return yield* bulkMetadata.failure;
            const response = assemblyMetadata();
            bulkMetadata.change(response);
            return response;
          }
          if (request.path.includes("/assemblies/")) return fixture.definition;
          if (request.path.includes("/parts/")) {
            const elementId = /\/e\/([^/]+)/.exec(request.path)?.[1];
            return metadata.filter((part) => !elementId || part.elementId === elementId);
          }
          return yield* Effect.die("Unexpected API request");
        }),
      readBinary: (request) =>
        Effect.gen(function* () {
          if (request.beforeRequest) yield* request.beforeRequest;
          requests.push(request);
          if (options.failDownload) return yield* new OnshapeRateLimitError({});
          if (request.beforeChunk) yield* request.beforeChunk(fixture.bytes.length);
          if (request.path.endsWith("/gltf")) {
            const batch = request.path.includes("/partstudios/");
            if (batch && options.batchFailure) return yield* options.batchFailure;
            const partId = batch
              ? fixture.definition.parts[0]!.partId
              : decodeURIComponent(request.path.split("/partid/")[1]!.split("/gltf")[0]!);
            const requested = new Set(new URLSearchParams(request.query).getAll("partId"));
            const nodes = fixture.definition.parts.flatMap((part, i) =>
              (
                batch && !options.batchMissingPart
                  ? requested.has(part.partId)
                  : part.partId === partId
              )
                ? [i]
                : [],
            );
            const bytes = yield* normalizeCadGeometry(
              new TextEncoder().encode(
                encodeFixture({
                  ...fixture.gltf,
                  nodes: fixture.gltf.nodes.slice(0, count),
                  scenes: [{ nodes }],
                }),
              ),
            ).pipe(Effect.orDie);
            return { bytes, contentType: "model/gltf-binary" };
          }
          const xml = threeMfXml(count, options.omitBody || options.omitTwoBodies);
          const bytes = threeMfArchive(
            options.omitTwoBodies
              ? xml.replace('<item objectid="3" transform="1 0 0 0 1 0 0 0 1 0.01 0 0"/>', "")
              : xml,
          );
          return { bytes, contentType: "model/3mf" };
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
        return yield* acquisition.acquire(bulkInput).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              Deferred.succeed(pollScheduled, duration).pipe(Effect.andThen(clock.sleep(duration))),
          }),
        );
      });
    return {
      acquire,
      metadata,
      definition: fixture.definition,
      bulkMetadata,
      readAsset: store.readAsset,
      requests,
      options,
      statusRead,
      pollScheduled,
    };
  });
const harness = <A, E, R>(
  use: (h: Effect.Success<ReturnType<typeof makeHarness>>) => Effect.Effect<A, E, R>,
  count = 400,
  multipleStudios = false,
) =>
  makeHarness(count, multipleStudios).pipe(
    Effect.flatMap(use),
    Effect.provide(
      layerTest(process.cwd(), { prefix: "onshape-bulk-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

describe("bulk snapshot acquisition", () => {
  it.effect(
    "uses one assembly metadata read across studios and keeps opacity and review identities",
    () =>
      harness(
        (h) =>
          Effect.gen(function* () {
            h.metadata[0]!.appearance.opacity = 127;
            const manifest = yield* h.acquire();
            assert.lengthOf(
              h.requests.filter((r) => r.path.endsWith("/bom")),
              1,
            );
            assert.lengthOf(
              h.requests.filter((r) => r.path.includes("/parts/")),
              0,
            );
            assert.equal(manifest.parts[0]!.metadata?.appearance?.opacity, 127);
            assert.equal(manifest.parts[0]!.metadata?.partIdentity, null);
            assert.equal(manifest.parts[0]!.metadata?.isHidden, null);
            assert.equal(manifest.nodes[1]!.sourcePartKey, manifest.parts[0]!.geometryKey);
            assert.lengthOf(manifest.assets, 4);
          }),
        4,
        true,
      ),
  );

  it.effect("matches abbreviated configurations only when the source match is unique", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          for (const part of [...h.definition.parts, ...h.definition.rootAssembly.instances]) {
            part.configuration = "Width=1;Finish=Default";
            part.fullConfiguration = part.configuration;
          }
          h.bulkMetadata.change = (response) => {
            for (const child of response.rows) {
              child.itemSource.configuration = "Width=1";
              Reflect.deleteProperty(child.itemSource, "fullConfiguration");
            }
          };
          const manifest = yield* h.acquire();
          assert.lengthOf(
            h.requests.filter((r) => r.path.endsWith("/bom")),
            1,
          );
          assert.lengthOf(
            h.requests.filter((r) => r.path.includes("/parts/")),
            0,
          );
          assert.equal(manifest.parts[0]!.source.fullConfiguration, "Width=1;Finish=Default");
        }),
      4,
      true,
    ),
  );

  it.effect("rejects ambiguous abbreviated configurations", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          // Two configurations of the same source part must not borrow each other's appearance.
          for (const i of [0, 2]) {
            for (const part of [h.definition.parts[i]!, h.definition.rootAssembly.instances[i]!]) {
              part.partId = "part-0";
              part.configuration = `Width=1;Finish=${i}`;
              part.fullConfiguration = part.configuration;
            }
          }
          h.bulkMetadata.change = (response) => {
            for (const i of [0, 2]) {
              response.rows[i]!.itemSource.configuration = "Width=1";
              Reflect.deleteProperty(response.rows[i]!.itemSource, "fullConfiguration");
            }
          };
          const manifest = yield* h.acquire();
          assert.lengthOf(
            h.requests.filter((r) => r.path.endsWith("/bom")),
            1,
          );
          assert.lengthOf(
            h.requests.filter((r) => r.path.includes("/parts/")),
            2,
          );
          assert.equal(manifest.parts[0]!.metadata?.isHidden, false);
        }),
      4,
      true,
    ),
  );

  it.effect("ignores bulk metadata for a different root revision", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.bulkMetadata.change = (response) => {
            response.bomSource.documentMicroversion.id = "000000000000000000000000";
          };
          yield* h.acquire();
          assert.lengthOf(
            h.requests.filter((r) => r.path.endsWith("/bom")),
            1,
          );
          assert.lengthOf(
            h.requests.filter((r) => r.path.includes("/parts/")),
            1,
          );
        }),
      4,
      true,
    ),
  );

  it.effect(
    "uses the BOM's explicit distinct configurations when it collapses equivalent parts",
    () =>
      harness(
        (h) =>
          Effect.gen(function* () {
            for (const part of [...h.definition.parts, ...h.definition.rootAssembly.instances]) {
              part.configuration = "Width=1;Visible=false";
              part.fullConfiguration = part.configuration;
            }
            h.bulkMetadata.change = (response) => {
              for (const row of response.rows) {
                row.itemSource.distinctConfigurations = [row.itemSource.fullConfiguration!];
                row.itemSource.fullConfiguration = "Width=1;Visible=true";
                row.itemSource.configuration = "Width=1";
              }
            };
            const manifest = yield* h.acquire();
            assert.lengthOf(
              h.requests.filter((r) => r.path.includes("/parts/")),
              0,
            );
            assert.equal(manifest.parts[0]!.source.fullConfiguration, "Width=1;Visible=false");
          }),
        4,
        true,
      ),
  );

  for (const fault of [
    "missing",
    "wrong-version",
    "wrong-configuration",
    "conflicting",
    "invalid-appearance",
    "missing-appearance",
  ] as const) {
    it.effect(`falls back only for the affected studio when assembly metadata is ${fault}`, () =>
      harness(
        (h) =>
          Effect.gen(function* () {
            h.bulkMetadata.change = (response) => {
              const child = response.rows[0]!;
              if (fault === "missing") response.rows.shift();
              if (fault === "wrong-version") child.itemSource.wvmId = "000000000000000000000000";
              if (fault === "wrong-configuration") child.itemSource.fullConfiguration = "Width=2";
              if (fault === "invalid-appearance")
                child.headerIdToValue["57f3fb8efa3416c06701d60c"] = "invalid";
              if (fault === "missing-appearance")
                Reflect.deleteProperty(child.headerIdToValue, "57f3fb8efa3416c06701d60c");
              if (fault === "conflicting")
                response.rows.push({
                  ...child,
                  headerIdToValue: {
                    ...child.headerIdToValue,
                    "57f3fb8efa3416c06701d60d": "Wrong part",
                  },
                });
            };
            const manifest = yield* h.acquire();
            assert.lengthOf(
              h.requests.filter((r) => r.path.endsWith("/bom")),
              1,
            );
            assert.lengthOf(
              h.requests.filter((r) => r.path.includes("/parts/")),
              1,
            );
            assert.equal(manifest.parts[0]!.metadata?.name, "Part 0");
            assert.lengthOf(manifest.assets, 4);
          }),
        4,
        true,
      ),
    );
  }

  for (const failure of [
    new OnshapeResponseError({ reason: "too-large" }),
    new OnshapeResponseError({ reason: "timeout" }),
    new OnshapeNetworkError(),
  ]) {
    it.effect(
      `falls back after an unavailable bulk metadata response: ${failure._tag} ${"reason" in failure ? failure.reason : ""}`,
      () =>
        harness(
          (h) =>
            Effect.gen(function* () {
              h.bulkMetadata.failure = failure;
              const manifest = yield* h.acquire();
              assert.lengthOf(
                h.requests.filter((r) => r.path.endsWith("/bom")),
                1,
              );
              assert.lengthOf(
                h.requests.filter((r) => r.path.includes("/parts/")),
                1,
              );
              assert.lengthOf(manifest.assets, 4);
            }),
          4,
          true,
        ),
    );
  }

  for (const failure of [
    new OnshapeInvalidCredentialsError(),
    new OnshapeInsufficientPermissionsError(),
    new OnshapeAnnualQuotaExceededError(),
    new OnshapeRateLimitError({}),
  ]) {
    it.effect(`does not spend fallback requests after ${failure._tag}`, () =>
      harness(
        (h) =>
          Effect.gen(function* () {
            h.bulkMetadata.failure = failure;
            const result = yield* h.acquire().pipe(Effect.result);
            assert.equal(result._tag, "Failure");
            assert.lengthOf(
              h.requests.filter((r) => r.path.endsWith("/bom")),
              1,
            );
            assert.lengthOf(
              h.requests.filter((r) => r.path.includes("/parts/") || r.method === "POST"),
              0,
            );
          }),
        4,
        true,
      ),
    );
  }

  it.effect("publishes translucent base faces while retaining opaque face overrides", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.metadata[0]!.appearance.opacity = 127;
          const manifest = yield* h.acquire();
          const bytes = yield* h.readAsset(manifest.snapshotId, manifest.assets[0]!.sha256);
          const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
          const { materials } = decodeMaterials(
            new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
          );
          assert.closeTo(
            materials[0]!.pbrMetallicRoughness.baseColorFactor[3]!,
            0.4980392156862745,
            1e-12,
          );
          assert.equal(materials[0]!.alphaMode, "BLEND");
          assert.equal(materials[1]!.pbrMetallicRoughness.baseColorFactor[3], 1);
        }),
      2,
    ),
  );
  it.effect("preserves authored part opacity in bulk snapshot metadata", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.metadata[0]!.appearance.opacity = 127;
          const manifest = yield* h.acquire();
          assert.equal(manifest.parts[0]!.metadata?.appearance?.opacity, 127);
          const metadataRequests = h.requests.filter((request) => request.path.includes("/parts/"));
          assert.lengthOf(metadataRequests, 1);
          assert.include(metadataRequests[0]!.path, "/v/777777777777777777777777/");
          assert.equal(
            new URLSearchParams(metadataRequests[0]!.query).get("linkDocumentId"),
            bulkInput.source.documentId,
          );
        }),
      2,
    ),
  );
  it.effect("downloads only an omitted source body and resumes without resubmission", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.options.omitBody = true;
          const result = yield* h.acquire();
          assert.lengthOf(result.assets, 2);
          const exports = h.requests.filter((request) => request.method === "POST");
          assert.lengthOf(exports, 1);
          const before = h.requests.length;
          assert.equal((yield* h.acquire()).snapshotId, result.snapshotId);
          assert.equal(h.requests.length - before, 1);
          const fallback = h.requests.filter((request) => request.path.includes("/partid/"));
          assert.lengthOf(fallback, 1);
          assert.include(fallback[0]!.path, "/v/777777777777777777777777/");
          assert.equal(
            new URLSearchParams(fallback[0]!.query).get("linkDocumentId"),
            bulkInput.source.documentId,
          );
          const bytes = yield* h.readAsset(result.snapshotId, result.assets[0]!.sha256);
          const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
          const { materials } = decodeMaterials(
            new TextDecoder().decode(bytes.subarray(20, 20 + length)),
          );
          assert.isTrue(materials.every((material) => material.doubleSided === true));
        }),
      2,
    ),
  );
  it.effect("batches only unresolved source bodies without a second assembly export", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.options.omitTwoBodies = true;
          const result = yield* h.acquire();
          assert.lengthOf(result.assets, 3);
          assert.lengthOf(
            h.requests.filter((r) => r.method === "POST"),
            1,
          );
          assert.lengthOf(
            h.requests.filter((r) => r.path.includes("/partid/")),
            0,
          );
          const batches = h.requests.filter((r) => r.path.includes("/partstudios/"));
          assert.lengthOf(batches, 1);
          assert.deepEqual(new URLSearchParams(batches[0]!.query).getAll("partId"), [
            "part-0",
            "part-1",
          ]);
          assert.lengthOf(h.requests, 7);
        }),
      3,
    ),
  );
  for (const fault of ["too-large", "timeout", "missing-part"] as const) {
    it.effect(`falls back only for unresolved geometry after a ${fault} studio batch`, () =>
      harness(
        (h) =>
          Effect.gen(function* () {
            h.options.omitTwoBodies = true;
            if (fault === "missing-part") h.options.batchMissingPart = true;
            else h.options.batchFailure = new OnshapeResponseError({ reason: fault });
            const result = yield* h.acquire();
            assert.lengthOf(result.assets, 3);
            assert.lengthOf(
              h.requests.filter((r) => r.method === "POST"),
              1,
            );
            assert.lengthOf(
              h.requests.filter((r) => r.path.includes("/partstudios/")),
              1,
            );
            assert.lengthOf(
              h.requests.filter((r) => r.path.includes("/partid/")),
              fault === "missing-part" ? 1 : 2,
            );
          }),
        3,
      ),
    );
  }
  it.effect(
    "downloads 400 distinct parts with one metadata request per studio and unchanged sync uses one revision check",
    () =>
      harness((h) =>
        Effect.gen(function* () {
          const first = yield* h.acquire();
          assert.lengthOf(first.parts, 400);
          assert.lengthOf(first.assets, 400);
          assert.lengthOf(h.requests, 6);
          assert.lengthOf(
            h.requests.filter((request) => request.path.includes("/partid/")),
            0,
          );
          const post = h.requests.find((request) => request.method === "POST");
          assert.isDefined(post);
          assert.include(post?.path, "/translations");
          assert.deepInclude("body" in post! ? post.body : {}, {
            formatName: "3MF",
            resolution: "coarse",
          });
          const second = yield* h.acquire();
          assert.equal(second.snapshotId, first.snapshotId);
          assert.lengthOf(h.requests, 7);
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
          assert.lengthOf(h.requests, 5);
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
  it.effect("waits twenty seconds before polling a newly submitted export", () =>
    harness(
      (h) =>
        Effect.gen(function* () {
          h.options.activeSubmission = true;
          const fiber = yield* h.acquire().pipe(Effect.forkChild);
          const delay = yield* Deferred.await(h.pollScheduled);
          assert.equal(Duration.toMillis(delay), 20_000);
          yield* TestClock.adjust("19 seconds");
          assert.lengthOf(
            h.requests.filter((r) => r.path.includes("/translations/")),
            0,
          );
          yield* TestClock.adjust("1 second");
          const manifest = yield* Fiber.join(fiber);
          assert.lengthOf(manifest.assets, 2);
          assert.lengthOf(
            h.requests.filter((r) => r.path.includes("/translations/")),
            1,
          );
        }),
      2,
    ),
  );
});
