import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  OnshapeProjectSource,
  ProjectId,
  OnshapeElementId,
  OnshapeRateLimitError,
  type CadSnapshotManifest,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CAD_SCENE_LIMITS } from "@cadsense/shared/cadSceneBudget";
import { CadSnapshotStore, CadSnapshotStoreError } from "../cad/CadSnapshotStore.ts";
import { OnshapeConnections, type OnshapeReadRequest } from "./OnshapeConnections.ts";
import * as Acquisition from "./OnshapeSnapshotAcquisition.ts";

const source = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "111111111111111111111111",
  workspaceType: "w",
  workspaceId: "222222222222222222222222",
  configuration: "ignored",
});
const mid = "333333333333333333333333";
const input = {
  projectId: ProjectId.make("project"),
  source,
  root: {
    elementId: OnshapeElementId.make("444444444444444444444444"),
    kind: "part-studio" as const,
    configuration: "Length=10 mm&Color=Red+Blue",
  },
};
const unused = () => Effect.die("Unexpected operation");
const rawGeometry = new TextEncoder().encode(
  '{"asset":{"version":"2.0"},"buffers":[{"byteLength":3,"uri":"data:application/octet-stream;base64,AQID"}]}',
);
const linked = {
  documentId: "555555555555555555555555",
  documentMicroversion: "666666666666666666666666",
  documentVersion: "777777777777777777777777",
  elementId: "888888888888888888888888",
  configuration: "Length=10",
  fullConfiguration: "Length=10;Width=5+mm",
  partId: "part+1",
};
const assembly = (version: string | null = linked.documentVersion) => ({
  rootAssembly: {
    documentId: source.documentId,
    documentMicroversion: mid,
    elementId: input.root.elementId,
    configuration: input.root.configuration,
    fullConfiguration: input.root.configuration,
    instances: ["one", "two"].map((id) => ({
      ...linked,
      documentVersion: version,
      id,
      name: id,
      type: "Part",
      suppressed: false,
    })),
    occurrences: ["one", "two"].map((id) => ({
      path: [id],
      hidden: false,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    })),
  },
  subAssemblies: [],
  parts: [{ ...linked, documentVersion: version }],
});
const harness = Effect.fn(function* (options?: {
  failReserve?: number;
  failBinary?: boolean;
  invalidPin?: boolean;
  linkedPin?: string;
  assembly?: unknown;
  rejectCachedGeometry?: boolean;
}) {
  const requests: OnshapeReadRequest[] = [];
  const published: CadSnapshotManifest[] = [];
  const events: string[] = [];
  let reserveChecks = 0;
  let active = false;
  const store = CadSnapshotStore.of({
    findGeometry: (keys) =>
      Effect.sync(() => {
        assert.isTrue(active);
        events.push("cache");
        if (options?.rejectCachedGeometry) return [];
        const requested = new Set(keys);
        return [
          ...new Map(
            published
              .flatMap((manifest) => manifest.assets)
              .filter((asset) => requested.has(asset.geometryKey))
              .map((asset) => [asset.geometryKey, asset]),
          ).values(),
        ];
      }),
    checkReserve: () =>
      Effect.gen(function* () {
        assert.isTrue(active);
        events.push("reserve");
        if (++reserveChecks === options?.failReserve)
          return yield* new CadSnapshotStoreError({ reason: "disk-space" });
      }),
    putAsset: (bytes) =>
      Effect.sync(() => {
        assert.isTrue(active);
        events.push("asset");
        assert.strictEqual(
          new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true),
          0x46546c67,
        );
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        return {
          sha256,
          byteLength: bytes.length,
          relativePath: `${sha256}.glb`,
          format: "glb" as const,
        };
      }),
    publish: (manifest) =>
      Effect.sync(() => {
        assert.isTrue(active);
        published.push(manifest);
      }),
    load: (id) =>
      Effect.sync(() => {
        const manifest = published.find((item) => item.snapshotId === id);
        if (!manifest) throw new Error("Missing fixture");
        return manifest;
      }),
    readAsset: unused,
    list: unused,
    remove: unused,
    withPinned: unused,
    withAcquisition: (effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active = true;
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            active = false;
          }),
      ),
  });
  const connections = OnshapeConnections.of({
    list: unused,
    create: unused,
    rename: unused,
    remove: unused,
    replaceCredentials: unused,
    readJson: (request) =>
      Effect.sync(() => {
        assert.strictEqual(events.at(-1), "reserve");
        events.push("json");
        requests.push(request);
        if (request.path.endsWith("currentmicroversion"))
          return options?.invalidPin
            ? {}
            : {
                microversion: request.path.includes(linked.documentId)
                  ? (options?.linkedPin ?? linked.documentMicroversion)
                  : mid,
              };
        if (request.path.includes("/assemblies/")) return options?.assembly;
        return [{ partId: "part+1", name: "Plate", bodyType: "solid", isHidden: true }];
      }),
    readBinary: (request) =>
      Effect.gen(function* () {
        if (request.beforeRequest) yield* request.beforeRequest;
        events.push("binary");
        requests.push(request);
        // Simulate a redirect: every separately signed hop must check reserve too.
        if (request.beforeRequest) yield* request.beforeRequest;
        if (options?.failBinary) return yield* new OnshapeRateLimitError({});
        if (request.beforeChunk) yield* request.beforeChunk(rawGeometry.length);
        return { bytes: rawGeometry, contentType: "model/gltf+json" };
      }),
  });
  const service = yield* Acquisition.make.pipe(
    Effect.provideService(CadSnapshotStore, store),
    Effect.provideService(OnshapeConnections, connections),
  );
  return { service, requests, published, events, active: () => active };
});

it.layer(NodeServices.layer)("Snapshot acquisition", (it) => {
  it.effect(
    "rejects an oversized tree before metadata or geometry requests and preserves the last snapshot",
    () =>
      Effect.gen(function* () {
        const oversized = assembly();
        oversized.rootAssembly.instances = Array.from(
          { length: CAD_SCENE_LIMITS.occurrences },
          (_, index) => ({ ...oversized.rootAssembly.instances[0]!, id: `part-${index}` }),
        );
        oversized.rootAssembly.occurrences = oversized.rootAssembly.instances.map((instance) => ({
          ...oversized.rootAssembly.occurrences[0]!,
          path: [instance.id],
        }));
        const options = { assembly: assembly() };
        const h = yield* harness(options);
        const root = { ...input.root, kind: "assembly" as const };
        const first = yield* h.service.acquire({ ...input, root });
        const previousRequests = h.requests.length;
        options.assembly = oversized;
        const failure = yield* h.service.acquire({ ...input, root }).pipe(Effect.flip);
        assert.equal(failure._tag, "CadGeometryError");
        assert.equal("reason" in failure ? failure.reason : null, "too-large");
        assert.equal(h.requests.length - previousRequests, 2);
        assert.deepEqual(h.published, [first]);
        assert.isFalse(h.active());
      }),
  );
  it.effect(
    "pins each workspace sync, preserves selected configuration, and reuses validated geometry",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        assert.deepEqual(h.requests, []);
        const first = yield* h.service.acquire(input);
        assert.lengthOf(h.requests, 3);
        assert.include(h.requests[1]!.path, `/m/${mid}/`);
        assert.strictEqual(
          new URLSearchParams(h.requests[2]!.query).get("configuration"),
          input.root.configuration,
        );
        assert.include(h.requests[2]!.path, "/partid/part%2B1/gltf");
        assert.isFalse(first.nodes[1]!.defaultVisible);
        assert.lengthOf(first.assets, 1);
        const second = yield* h.service.acquire(input);
        assert.notStrictEqual(second.snapshotId, first.snapshotId);
        assert.lengthOf(h.requests, 5);
        assert.deepEqual(second.assets, first.assets);
        assert.isFalse(h.active());
      }),
  );
  it.effect("does not resolve an immutable microversion", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.acquire({ ...input, source: { ...source, workspaceType: "m" } });
      assert.lengthOf(h.requests, 2);
      assert.include(h.requests[0]!.path, `/m/${source.workspaceId}/`);
    }),
  );
  it.effect.each([1, 2, 3, 4, 5])(
    "disk reserve failure at check %s prevents publication",
    (failReserve) =>
      Effect.gen(function* () {
        const h = yield* harness({ failReserve });
        const error = yield* h.service.acquire(input).pipe(Effect.flip);
        assert.strictEqual(error._tag, "CadSnapshotStoreError");
        assert.lengthOf(h.published, 0);
        assert.isFalse(h.active());
        assert.lengthOf(h.requests, Math.min(failReserve - 1, 3));
      }),
  );
  it.effect("quota failure does not retry or publish", () =>
    Effect.gen(function* () {
      const h = yield* harness({ failBinary: true });
      const error = yield* h.service
        .acquire({ ...input, root: { ...input.root, configuration: "Length=20" } })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "OnshapeRateLimitError");
      assert.lengthOf(h.requests, 3);
      assert.lengthOf(h.published, 0);
      assert.isFalse(h.active());
    }),
  );
  it.effect("failed later sync preserves the previously published immutable snapshot", () =>
    Effect.gen(function* () {
      const options = { failBinary: false };
      const h = yield* harness(options);
      const first = yield* h.service.acquire(input);
      options.failBinary = true;
      const error = yield* h.service
        .acquire({ ...input, root: { ...input.root, configuration: "Length=20" } })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "OnshapeRateLimitError");
      assert.deepEqual(h.published, [first]);
      assert.isFalse(h.active());
    }),
  );
  it.effect("invalid pin response prevents downstream requests", () =>
    Effect.gen(function* () {
      const h = yield* harness({ invalidPin: true });
      const error = yield* h.service.acquire(input).pipe(Effect.flip);
      assert.strictEqual(error._tag, "OnshapeSnapshotAcquisitionError");
      assert.lengthOf(h.requests, 1);
      assert.lengthOf(h.published, 0);
    }),
  );
  it.effect(
    "groups repeated linked parts and exports once at immutable V with evaluated configuration",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ assembly: assembly() });
        const result = yield* h.service.acquire({
          ...input,
          root: { ...input.root, kind: "assembly" },
        });
        assert.lengthOf(result.nodes, 3);
        assert.lengthOf(result.parts, 1);
        assert.lengthOf(result.assets, 1);
        assert.lengthOf(h.requests, 5);
        assert.lengthOf(
          h.requests.filter(
            (request) =>
              request.path.includes(linked.documentId) &&
              request.path.endsWith("currentmicroversion"),
          ),
          1,
        );
        for (const request of h.requests
          .slice(2)
          .filter((request) => !request.path.endsWith("currentmicroversion"))) {
          assert.include(
            request.path,
            `/d/${linked.documentId}/v/${linked.documentVersion}/e/${linked.elementId}`,
          );
          const query = new URLSearchParams(request.query);
          assert.strictEqual(query.get("configuration"), linked.fullConfiguration);
          assert.strictEqual(query.get("linkDocumentId"), source.documentId);
        }
        const definitionQuery = new URLSearchParams(h.requests[1]!.query);
        assert.strictEqual(definitionQuery.get("excludeSuppressed"), "false");
        assert.strictEqual(definitionQuery.get("includeNonSolids"), "true");
        assert.strictEqual(definitionQuery.get("includeMateFeatures"), "false");
      }),
  );
  it.effect("missing linked version fails before spending metadata or export requests", () =>
    Effect.gen(function* () {
      const h = yield* harness({ assembly: assembly(null) });
      const error = yield* h.service
        .acquire({ ...input, root: { ...input.root, kind: "assembly" } })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "OnshapeSnapshotAcquisitionError");
      assert.lengthOf(h.requests, 2);
      assert.lengthOf(h.published, 0);
    }),
  );
  it.effect("linked version pin mismatch fails before geometry export", () =>
    Effect.gen(function* () {
      const h = yield* harness({ assembly: assembly(), linkedPin: mid });
      const error = yield* h.service
        .acquire({ ...input, root: { ...input.root, kind: "assembly" } })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "OnshapeSnapshotAcquisitionError");
      assert.lengthOf(h.requests, 4);
      assert.lengthOf(h.published, 0);
    }),
  );
  it.effect("different version provenance of the same immutable geometry exports only once", () =>
    Effect.gen(function* () {
      const definition = assembly();
      const otherVersion = "999999999999999999999999";
      definition.rootAssembly.instances[1]!.documentVersion = otherVersion;
      definition.parts.push({ ...linked, documentVersion: otherVersion });
      const h = yield* harness({ assembly: definition });
      const manifest = yield* h.service.acquire({
        ...input,
        root: { ...input.root, kind: "assembly" },
      });
      assert.lengthOf(manifest.nodes, 3);
      assert.lengthOf(manifest.parts, 1);
      assert.lengthOf(
        h.requests.filter((request) => request.path.endsWith("/gltf")),
        1,
      );
    }),
  );
  it.effect("reuses environment geometry across distinct projects and assembly roots", () =>
    Effect.gen(function* () {
      const definition = assembly();
      const h = yield* harness({ assembly: definition });
      const first = yield* h.service.acquire({
        ...input,
        root: { ...input.root, kind: "assembly" },
      });
      const otherElement = OnshapeElementId.make("aaaaaaaaaaaaaaaaaaaaaaaa");
      definition.rootAssembly.elementId = otherElement;
      const second = yield* h.service.acquire({
        ...input,
        projectId: ProjectId.make("another-project"),
        root: { ...input.root, elementId: otherElement, kind: "assembly" },
      });
      assert.notStrictEqual(second.rootId, first.rootId);
      assert.notStrictEqual(second.projectId, first.projectId);
      assert.deepEqual(second.assets, first.assets);
      assert.lengthOf(
        h.requests.filter((request) => request.path.endsWith("/gltf")),
        1,
      );
      assert.lengthOf(
        h.events.filter((event) => event === "cache"),
        2,
      );
    }),
  );
  it.effect("exports anew when store validation excludes an existing cache candidate", () =>
    Effect.gen(function* () {
      const options = { rejectCachedGeometry: false };
      const h = yield* harness(options);
      yield* h.service.acquire(input);
      options.rejectCachedGeometry = true;
      yield* h.service.acquire(input);
      assert.lengthOf(
        h.requests.filter((request) => request.path.endsWith("/gltf")),
        2,
      );
      assert.lengthOf(h.published, 2);
    }),
  );
});
