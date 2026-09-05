// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { NodeServices } from "@effect/platform-node";
import { CadSnapshotRoot, ProjectId } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig, layerTest } from "../config.ts";
import {
  completeSnapshotManifest,
  parsePartStudioSnapshotDraft,
  snapshotRootId,
} from "../onshape/OnshapeSnapshotManifest.ts";
import {
  CAD_DISK_RESERVE_BYTES,
  CadDiskSpace,
  make,
  type CadSnapshotStoreShape,
} from "./CadSnapshotStore.ts";

const bytes = new Uint8Array([1, 2, 3, 4]);
const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const root = Schema.decodeUnknownSync(CadSnapshotRoot)({
  host: "https://cad.onshape.com",
  documentId: "111111111111111111111111",
  elementId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  kind: "part-studio",
  originalRevision: { kind: "w", id: "999999999999999999999999" },
  microversionId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  configuration: "default",
  tessellationProfile: "test-medium-v1",
});
const fixture = Effect.fn(function* (store: CadSnapshotStoreShape, snapshotId = firstId) {
  const draft = yield* parsePartStudioSnapshotDraft(
    {
      snapshotId,
      projectId: ProjectId.make(snapshotId),
      createdAt: "2026-09-05T00:00:00Z",
      root,
      rootId: snapshotRootId(root),
    },
    [{ partId: "A", name: "Body", bodyType: "solid" }],
  );
  const asset = yield* store.putAsset(bytes);
  return yield* completeSnapshotManifest(draft, [
    { ...asset, geometryKey: draft.parts[0]!.geometryKey },
  ]);
});
const harness = <A, E, R>(
  use: (
    store: CadSnapshotStoreShape,
    directory: string,
    setAvailable: (n: number) => void,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      let available = CAD_DISK_RESERVE_BYTES * 2;
      const store = yield* make.pipe(
        Effect.provideService(CadDiskSpace, { availableBytes: () => Effect.sync(() => available) }),
      );
      return yield* use(store, NodePath.join(config.stateDir, "cad"), (n) => {
        available = n;
      });
    }).pipe(
      Effect.provide(
        layerTest(process.cwd(), { prefix: "cadsense-snapshot-store-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

describe("CadSnapshotStore", () => {
  it.effect(
    "startup reclaims failed acquisition assets and staging, preserving published geometry",
    () =>
      harness((store, dir) =>
        Effect.gen(function* () {
          yield* store.publish(yield* fixture(store));
          yield* store.putAsset(new Uint8Array([8]));
          const staged = NodePath.join(dir, "staging", `${secondId}.tmp`);
          yield* Effect.promise(() => NodeFSP.writeFile(staged, bytes));
          const restarted = yield* make.pipe(
            Effect.provideService(CadDiskSpace, {
              availableBytes: () => Effect.succeed(CAD_DISK_RESERVE_BYTES * 2),
            }),
          );
          yield* restarted.load(firstId);
          assert.strictEqual(
            (yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets")))).length,
            1,
          );
          assert.deepStrictEqual(
            yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "staging"))),
            [],
          );
        }),
      ),
  );
  it.effect("retains shared assets conservatively when a retained manifest is corrupt", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        yield* store.publish(yield* fixture(store));
        yield* store.publish(yield* fixture(store, secondId));
        const secondPath = NodePath.join(dir, "manifests", `${secondId}.json`);
        const original = yield* Effect.promise(() => NodeFSP.readFile(secondPath));
        yield* Effect.promise(() => NodeFSP.writeFile(secondPath, "broken"));
        assert.strictEqual((yield* Effect.flip(store.remove([firstId], []))).reason, "corrupt");
        assert.strictEqual(
          (yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets")))).length,
          1,
        );
        yield* Effect.promise(() => NodeFSP.writeFile(secondPath, original));
        yield* store.remove([firstId], []);
        yield* store.load(secondId);
      }),
    ),
  );
  it.effect("failed pinned users and interrupted acquisitions release protection", () =>
    harness((store) =>
      Effect.gen(function* () {
        yield* store.publish(yield* fixture(store));
        yield* Effect.flip(store.withPinned(firstId, () => Effect.fail("user failure")));
        const entered = yield* Deferred.make<void>();
        const fiber = yield* store
          .withAcquisition(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        yield* store.remove([firstId], []);
      }),
    ),
  );
  it.effect("publishes immutable complete snapshots and deduplicates content", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        const manifest = yield* fixture(store);
        yield* store.publish(manifest);
        yield* store.publish(manifest);
        assert.deepStrictEqual(yield* store.load(firstId), manifest);
        assert.deepStrictEqual(
          Array.from(yield* store.readAsset(firstId, manifest.assets[0]!.sha256)),
          Array.from(bytes),
        );
        yield* store.putAsset(bytes);
        assert.strictEqual(
          (yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets")))).length,
          1,
        );
        assert.strictEqual(
          (yield* Effect.flip(store.publish({ ...manifest, createdAt: "2026-09-06T00:00:00Z" })))
            .reason,
          "corrupt",
        );
        const summaries = yield* store.list();
        assert.strictEqual(summaries[0]!.byteLength, 4);
        assert.isFalse("nodes" in summaries[0]!);
      }),
    ),
  );
  it.effect("rejects corrupt bytes and out-of-snapshot asset access", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        const manifest = yield* fixture(store);
        yield* store.publish(manifest);
        assert.strictEqual(
          (yield* Effect.flip(store.readAsset(firstId, "0".repeat(64)))).reason,
          "corrupt",
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(dir, "assets", manifest.assets[0]!.relativePath),
            new Uint8Array([5]),
          ),
        );
        assert.strictEqual((yield* Effect.flip(store.load(firstId))).reason, "corrupt");
        assert.strictEqual((yield* Effect.flip(store.putAsset(bytes))).reason, "corrupt");
      }),
    ),
  );
  it.effect("reserves two GiB before writes, while permitting validated reuse", () =>
    harness((store, _dir, setAvailable) =>
      Effect.gen(function* () {
        yield* store.putAsset(bytes);
        setAvailable(CAD_DISK_RESERVE_BYTES);
        yield* store.putAsset(bytes);
        assert.strictEqual(
          (yield* Effect.flip(store.putAsset(new Uint8Array([9])))).reason,
          "disk-space",
        );
        assert.strictEqual(
          (yield* Effect.flip(store.checkReserve(Number.NaN))).reason,
          "disk-space",
        );
      }),
    ),
  );
  it.effect("retains shared geometry across projects and honors protected snapshots", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        yield* store.publish(yield* fixture(store));
        yield* store.publish(yield* fixture(store, secondId));
        assert.strictEqual((yield* Effect.flip(store.remove([firstId], [firstId]))).reason, "busy");
        yield* store.remove([firstId], []);
        yield* store.load(secondId);
        yield* store.remove([secondId], []);
        assert.deepStrictEqual(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets"))),
          [],
        );
        yield* store.remove([secondId], []);
      }),
    ),
  );
  it.effect("pins and acquisition reservations block cleanup until their scopes settle", () =>
    harness((store) =>
      Effect.gen(function* () {
        yield* store.publish(yield* fixture(store));
        for (const reserve of [
          store.withAcquisition,
          <A, E, R>(effect: Effect.Effect<A, E, R>) => store.withPinned(firstId, () => effect),
        ]) {
          const entered = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const fiber = yield* reserve(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          assert.strictEqual((yield* Effect.flip(store.remove([firstId], []))).reason, "busy");
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(fiber);
        }
        yield* store.remove([firstId], []);
      }),
    ),
  );
  it.effect("keeps a cleanup ledger so interrupted geometry deletion can be retried", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        const manifest = yield* fixture(store);
        yield* store.publish(manifest);
        const assetPath = NodePath.join(dir, "assets", manifest.assets[0]!.relativePath);
        yield* Effect.promise(async () => {
          await NodeFSP.unlink(assetPath);
          await NodeFSP.mkdir(assetPath);
        });
        assert.strictEqual((yield* Effect.flip(store.remove([firstId], []))).reason, "corrupt");
        assert.deepStrictEqual(yield* store.list(), []);
        assert.deepStrictEqual(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "retired"))),
          [`${firstId}.json`],
        );
        yield* Effect.promise(async () => {
          await NodeFSP.rmdir(assetPath);
          await NodeFSP.writeFile(assetPath, bytes);
        });
        yield* store.remove([firstId], []);
        assert.deepStrictEqual(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "retired"))),
          [],
        );
        assert.deepStrictEqual(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets"))),
          [],
        );
      }),
    ),
  );
  it.effect("rejects traversal IDs and directory junction escapes", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* Effect.flip(store.load("../escape"))).reason, "corrupt");
        const external = NodePath.join(dir, "external");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(external);
          await NodeFSP.rmdir(NodePath.join(dir, "assets"));
          await NodeFSP.symlink(external, NodePath.join(dir, "assets"), "junction");
        });
        assert.strictEqual((yield* Effect.flip(store.putAsset(bytes))).reason, "unavailable");
        assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(external)), []);
      }),
    ),
  );
});
