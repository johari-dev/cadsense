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
  for (const damage of ["hash", "length", "missing", "directory", "oversized"] as const)
    it.effect(`load rejects ${damage} damage in the last verification cohort`, () =>
      harness((store, dir) =>
        Effect.gen(function* () {
          const draft = yield* parsePartStudioSnapshotDraft(
            {
              snapshotId: firstId,
              projectId: ProjectId.make(firstId),
              createdAt: "2026-09-05T00:00:00Z",
              root,
              rootId: snapshotRootId(root),
            },
            Array.from({ length: 9 }, (_, id) => ({
              partId: `part-${id}`,
              name: `Part ${id}`,
              bodyType: "solid",
            })),
          );
          const assets = yield* Effect.forEach(draft.parts, (part, index) =>
            store
              .putAsset(new Uint8Array([index, 2, 3, 4]))
              .pipe(Effect.map((asset) => ({ ...asset, geometryKey: part.geometryKey }))),
          );
          const manifest = yield* completeSnapshotManifest(draft, assets);
          yield* store.publish(manifest);
          assert.deepStrictEqual(yield* store.load(firstId), manifest);
          const target = NodePath.join(dir, "assets", assets[8]!.relativePath);
          yield* Effect.promise(async () => {
            switch (damage) {
              case "hash":
                await NodeFSP.writeFile(target, new Uint8Array([9, 9, 9, 9]));
                break;
              case "length":
                await NodeFSP.writeFile(target, new Uint8Array([8]));
                break;
              case "missing":
                await NodeFSP.unlink(target);
                break;
              case "directory":
                await NodeFSP.unlink(target);
                await NodeFSP.mkdir(target);
                break;
              case "oversized":
                await NodeFSP.truncate(target, 512 * 1024 ** 2 + 1);
                break;
            }
          });
          assert.strictEqual((yield* Effect.flip(store.load(firstId))).reason, "corrupt");
          let exposed = false;
          yield* Effect.flip(
            store.withPinned(firstId, () =>
              Effect.sync(() => {
                exposed = true;
              }),
            ),
          );
          assert.isFalse(exposed);
        }),
      ),
    );
  it.effect("cancellation collects orphan geometry while an unrelated snapshot stays pinned", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        const manifest = yield* fixture(store);
        yield* store.publish(manifest);
        yield* store.withPinned(firstId, (_manifest, read) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const fiber = yield* store
              .withAcquisition(
                store
                  .putAsset(new Uint8Array([9]))
                  .pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Effect.never),
                  ),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(fiber);
            assert.deepStrictEqual(
              yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets"))),
              [manifest.assets[0]!.relativePath],
            );
            assert.deepStrictEqual(
              Array.from(yield* read(manifest.assets[0]!.sha256)),
              Array.from(bytes),
            );
            assert.strictEqual((yield* Effect.flip(store.remove([firstId], []))).reason, "busy");
          }),
        );
      }),
    ),
  );
  it.effect("corrupt-asset repair never replaces a junction at the hash filename", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        const asset = yield* store.putAsset(bytes);
        const path = NodePath.join(dir, "assets", asset.relativePath);
        const external = NodePath.join(dir, "external-asset");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(external);
          await NodeFSP.unlink(path);
          await NodeFSP.symlink(external, path, "junction");
        });
        assert.strictEqual((yield* Effect.flip(store.putAsset(bytes))).reason, "corrupt");
        assert.isTrue((yield* Effect.promise(() => NodeFSP.lstat(path))).isSymbolicLink());
        assert.deepStrictEqual(yield* Effect.promise(() => NodeFSP.readdir(external)), []);
      }),
    ),
  );
  it.effect(
    "cancelled acquisition cleans bytes and blocked cleanup retries on the next release",
    () =>
      harness((store, dir) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const fiber = yield* store
            .withAcquisition(
              store
                .putAsset(bytes)
                .pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Effect.never),
                ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
          assert.deepStrictEqual(
            yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets"))),
            [],
          );
          const asset = yield* store.withAcquisition(
            Effect.gen(function* () {
              const asset = yield* store.putAsset(bytes);
              const path = NodePath.join(dir, "assets", asset.relativePath);
              yield* Effect.promise(async () => {
                await NodeFSP.unlink(path);
                await NodeFSP.mkdir(path);
              });
              return asset;
            }),
          );
          const path = NodePath.join(dir, "assets", asset.relativePath);
          yield* Effect.promise(async () => {
            await NodeFSP.rmdir(path);
            await NodeFSP.writeFile(path, bytes);
          });
          yield* store.withAcquisition(Effect.void);
          assert.deepStrictEqual(
            yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets"))),
            [],
          );
        }),
      ),
  );
  it.effect("finds validated geometry across retained projects, skipping corrupt candidates", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        const first = yield* fixture(store);
        yield* store.publish(first);
        const second = yield* fixture(store, secondId);
        yield* store.publish(second);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, "manifests", `${firstId}.json`), "broken"),
        );
        assert.deepStrictEqual(
          yield* store.findGeometry([first.assets[0]!.geometryKey, "b".repeat(64)]),
          second.assets,
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, "assets", first.assets[0]!.relativePath), "broken"),
        );
        assert.deepStrictEqual(yield* store.findGeometry([first.assets[0]!.geometryKey]), []);
      }),
    ),
  );
  it.effect("cleans failed acquisition assets immediately without changing its error", () =>
    harness((store, dir) =>
      Effect.gen(function* () {
        const failure = { message: "acquisition failed" };
        assert.strictEqual(
          yield* Effect.flip(
            store.withAcquisition(store.putAsset(bytes).pipe(Effect.andThen(Effect.fail(failure)))),
          ),
          failure,
        );
        assert.deepStrictEqual(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets"))),
          [],
        );
      }),
    ),
  );
  it.effect(
    "the last concurrent acquisition collects failures but preserves published geometry",
    () =>
      harness((store, dir) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const candidate = yield* fixture(store);
          const fiber = yield* store
            .withAcquisition(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.andThen(store.publish(candidate)),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* store.withAcquisition(store.putAsset(new Uint8Array([9])));
          assert.strictEqual(
            (yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets")))).length,
            2,
          );
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(fiber);
          assert.strictEqual(
            (yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "assets")))).length,
            1,
          );
          yield* store.load(firstId);
        }),
      ),
  );
  it.effect(
    "pinned readers use one validated manifest, verify each asset, and expire with their session",
    () =>
      harness((store, dir) =>
        Effect.gen(function* () {
          const manifest = yield* fixture(store);
          yield* store.publish(manifest);
          const read = yield* store.withPinned(firstId, (_manifest, read) =>
            Effect.gen(function* () {
              const path = NodePath.join(dir, "manifests", `${firstId}.json`);
              const original = yield* Effect.promise(() => NodeFSP.readFile(path));
              yield* Effect.promise(() => NodeFSP.writeFile(path, "broken"));
              assert.deepStrictEqual(
                Array.from(yield* read(manifest.assets[0]!.sha256)),
                Array.from(bytes),
              );
              assert.deepStrictEqual(
                Array.from(yield* read(manifest.assets[0]!.sha256)),
                Array.from(bytes),
              );
              yield* Effect.promise(() => NodeFSP.writeFile(path, original));
              return read;
            }),
          );
          assert.strictEqual((yield* Effect.flip(read(manifest.assets[0]!.sha256))).reason, "busy");
        }),
      ),
  );
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
  it.effect("repairs referenced corrupt bytes only after reserve admission", () =>
    harness((store, dir, setAvailable) =>
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
        setAvailable(CAD_DISK_RESERVE_BYTES);
        assert.strictEqual((yield* Effect.flip(store.putAsset(bytes))).reason, "disk-space");
        assert.deepStrictEqual(
          Array.from(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(dir, "assets", manifest.assets[0]!.relativePath)),
            ),
          ),
          [5],
        );
        setAvailable(CAD_DISK_RESERVE_BYTES * 2);
        yield* store.putAsset(bytes);
        assert.deepStrictEqual(yield* store.load(firstId), manifest);
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
