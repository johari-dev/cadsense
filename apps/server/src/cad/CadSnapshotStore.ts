// @effect-diagnostics nodeBuiltinImport:off
// This filesystem adapter needs lstat and atomic non-replacing links; disk reserve uses statfs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CadHash,
  CadSnapshotId,
  CadSnapshotManifest,
  type CadGeometryAsset,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { completeSnapshotManifest } from "../onshape/OnshapeSnapshotManifest.ts";

export const CAD_DISK_RESERVE_BYTES = 2 * 1024 ** 3;
const MAX_MANIFEST_BYTES = 128 * 1024 ** 2;
const MAX_ASSET_BYTES = 512 * 1024 ** 2;
const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const decodeManifestJson = Schema.decodeUnknownSync(Schema.fromJsonString(CadSnapshotManifest));
const encodeManifestJson = Schema.encodeSync(Schema.fromJsonString(CadSnapshotManifest));
const decodeSnapshotId = Schema.decodeUnknownSync(CadSnapshotId);
const decodeHash = Schema.decodeUnknownSync(CadHash);

export class CadSnapshotStoreError extends Schema.TaggedErrorClass<CadSnapshotStoreError>()(
  "CadSnapshotStoreError",
  { reason: Schema.Literals(["disk-space", "unavailable", "corrupt", "busy"]) },
) {}

export class CadDiskSpace extends Context.Service<
  CadDiskSpace,
  {
    readonly availableBytes: (directory: string) => Effect.Effect<number, CadSnapshotStoreError>;
  }
>()("@cadsense/server/cad/CadSnapshotStore/CadDiskSpace") {}

export const diskSpaceLayer = Layer.succeed(CadDiskSpace, {
  availableBytes: (directory) =>
    Effect.tryPromise({
      try: async () => {
        const stat = await NodeFSP.statfs(directory);
        return stat.bavail * stat.bsize;
      },
      catch: () => new CadSnapshotStoreError({ reason: "unavailable" }),
    }),
});

export type CadStoredAsset = Omit<CadGeometryAsset, "geometryKey">;
export type CadSnapshotSummary = Pick<
  CadSnapshotManifest,
  "snapshotId" | "projectId" | "rootId" | "createdAt"
> & { readonly byteLength: number };
export interface CadSnapshotStoreShape {
  readonly findGeometry: (
    keys: readonly string[],
  ) => Effect.Effect<readonly CadGeometryAsset[], CadSnapshotStoreError>;
  readonly checkReserve: (additionalBytes?: number) => Effect.Effect<void, CadSnapshotStoreError>;
  readonly putAsset: (bytes: Uint8Array) => Effect.Effect<CadStoredAsset, CadSnapshotStoreError>;
  readonly publish: (manifest: CadSnapshotManifest) => Effect.Effect<void, CadSnapshotStoreError>;
  readonly load: (snapshotId: string) => Effect.Effect<CadSnapshotManifest, CadSnapshotStoreError>;
  readonly readAsset: (
    snapshotId: string,
    sha256: string,
  ) => Effect.Effect<Uint8Array, CadSnapshotStoreError>;
  readonly list: () => Effect.Effect<readonly CadSnapshotSummary[], CadSnapshotStoreError>;
  readonly remove: (
    snapshotIds: readonly string[],
    protectedIds: readonly string[],
  ) => Effect.Effect<void, CadSnapshotStoreError>;
  readonly withPinned: <A, E, R>(
    snapshotId: string,
    use: (
      manifest: CadSnapshotManifest,
      readAsset: (sha256: string) => Effect.Effect<Uint8Array, CadSnapshotStoreError>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CadSnapshotStoreError, R>;
  readonly withAcquisition: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export class CadSnapshotStore extends Context.Service<CadSnapshotStore, CadSnapshotStoreShape>()(
  "@cadsense/server/cad/CadSnapshotStore",
) {}

const failure = (reason: CadSnapshotStoreError["reason"]) => new CadSnapshotStoreError({ reason });
const isStoreError = Schema.is(CadSnapshotStoreError);
const io = <A>(run: () => Promise<A>, reason: CadSnapshotStoreError["reason"] = "unavailable") =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (isStoreError(error) ? error : failure(reason)),
  }).pipe(Effect.uninterruptible);
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) =>
  Predicate.isObject(error) && "code" in error && error.code === "ENOENT";

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const disk = yield* CadDiskSpace;
  const lock = yield* Semaphore.make(1);
  const root = NodePath.join(config.stateDir, "cad");
  const assets = NodePath.join(root, "assets");
  const manifests = NodePath.join(root, "manifests");
  const staging = NodePath.join(root, "staging");
  const retired = NodePath.join(root, "retired");
  const pins = new Map<string, number>();
  let acquisitions = 0;
  const pendingOrphans = new Set<string>();

  const assertDirectory = async (directory: string) => {
    const stat = await NodeFSP.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("unavailable");
  };
  const assertDirectories = async () => {
    for (const directory of [config.stateDir, root, assets, manifests, staging, retired])
      await assertDirectory(directory);
  };
  yield* io(async () => {
    await assertDirectory(config.stateDir);
    for (const directory of [root, assets, manifests, staging, retired]) {
      await NodeFSP.mkdir(directory, { recursive: false }).catch((error: unknown) => {
        if (!(Predicate.isObject(error) && "code" in error && error.code === "EEXIST")) throw error;
      });
      await assertDirectory(directory);
    }
    // Only our UUID temporary files are disposable. Assets may belong to an interrupted acquisition.
    for (const name of await NodeFSP.readdir(staging)) {
      if (!/^[a-f0-9-]{36}\.tmp$/.test(name)) continue;
      const path = NodePath.join(staging, name);
      const stat = await NodeFSP.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure("unavailable");
      await NodeFSP.unlink(path);
    }
  });

  const checkReserve = Effect.fn("CadSnapshotStore.checkReserve")(function* (additionalBytes = 0) {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0)
      return yield* failure("disk-space");
    const available = yield* disk.availableBytes(root);
    if (!Number.isFinite(available) || available - additionalBytes < CAD_DISK_RESERVE_BYTES)
      return yield* failure("disk-space");
  });
  const readFile = async (path: string, limit: number) => {
    const stat = await NodeFSP.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw failure("corrupt");
    const bytes = await NodeFSP.readFile(path);
    if (bytes.length > limit) throw failure("corrupt");
    return bytes;
  };
  const atomicWrite = async (destination: string, bytes: Uint8Array, repair = false) => {
    const temp = NodePath.join(staging, `${NodeCrypto.randomUUID()}.tmp`);
    try {
      await NodeFSP.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      if (repair) await NodeFSP.rename(temp, destination);
      else await NodeFSP.link(temp, destination);
    } finally {
      await NodeFSP.unlink(temp).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  };
  const manifestPath = (id: string) => NodePath.join(manifests, `${decodeSnapshotId(id)}.json`);
  const readManifest = async (id: string, directory = manifests) => {
    const bytes = await readFile(
      NodePath.join(directory, `${decodeSnapshotId(id)}.json`),
      MAX_MANIFEST_BYTES,
    );
    const value = decodeManifestJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value.snapshotId !== id) throw failure("corrupt");
    return value;
  };
  const verifyAsset = async (asset: CadStoredAsset) => {
    if (asset.relativePath !== `${decodeHash(asset.sha256)}.glb`) throw failure("corrupt");
    const bytes = await readFile(NodePath.join(assets, asset.relativePath), MAX_ASSET_BYTES);
    if (bytes.length !== asset.byteLength || hash(bytes) !== asset.sha256) throw failure("corrupt");
    return bytes;
  };
  const validateManifest = (manifest: CadSnapshotManifest) =>
    completeSnapshotManifest(manifest, manifest.assets).pipe(
      Effect.mapError(() => failure("corrupt")),
    );
  // Run only at startup or under the mutex when every acquisition has settled.
  // Pinned snapshots retain their manifests, so the reference scan protects their geometry.
  const collectOrphans = Effect.fn("CadSnapshotStore.collectOrphans")(function* () {
    if (acquisitions > 0) return;
    yield* io(assertDirectories);
    const references = new Set<string>();
    for (const directory of [manifests, retired]) {
      for (const name of yield* io(() => NodeFSP.readdir(directory))) {
        if (!name.endsWith(".json")) return yield* failure("corrupt");
        const manifest = yield* io(
          () => readManifest(name.slice(0, -5), directory),
          "corrupt",
        ).pipe(Effect.flatMap(validateManifest), Effect.option);
        if (manifest._tag === "None") return yield* failure("corrupt");
        for (const asset of manifest.value.assets) references.add(asset.relativePath);
      }
    }
    yield* io(async () => {
      for (const name of new Set([...pendingOrphans, ...(await NodeFSP.readdir(assets))])) {
        if (!/^[a-f0-9]{64}\.glb$/.test(name) || references.has(name)) {
          pendingOrphans.delete(name);
          continue;
        }
        const path = NodePath.join(assets, name);
        pendingOrphans.add(name);
        try {
          const stat = await NodeFSP.lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          await NodeFSP.unlink(path);
          pendingOrphans.delete(name);
        } catch (error) {
          if (missing(error)) pendingOrphans.delete(name);
        }
      }
    });
    if (pendingOrphans.size > 0)
      yield* Effect.logWarning("CAD asset cleanup pending; local cleanup will retry.");
  });
  const retryOrphanCleanup = () =>
    collectOrphans().pipe(
      Effect.catch((error) =>
        Effect.logWarning("CAD asset cleanup pending; local cleanup will retry.", {
          reason: error.reason,
        }),
      ),
    );
  yield* retryOrphanCleanup();
  const findGeometry = (keys: readonly string[]) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* io(assertDirectories);
        const requested = yield* Effect.try({
          try: () => new Set(keys.map((key) => decodeHash(key))),
          catch: () => failure("corrupt"),
        });
        const found = new Map<string, CadGeometryAsset>();
        for (const name of yield* io(() => NodeFSP.readdir(manifests))) {
          if (found.size === requested.size) break;
          if (!name.endsWith(".json")) continue;
          const manifest = yield* io(() => readManifest(name.slice(0, -5)), "corrupt").pipe(
            Effect.flatMap(validateManifest),
            Effect.option,
          );
          if (manifest._tag === "None") continue;
          for (const asset of manifest.value.assets) {
            if (!requested.has(asset.geometryKey) || found.has(asset.geometryKey)) continue;
            const verified = yield* io(() => verifyAsset(asset), "corrupt").pipe(Effect.option);
            if (verified._tag === "Some") found.set(asset.geometryKey, asset);
          }
        }
        return [...found.values()];
      }),
    );
  const loadUnlocked = Effect.fn("CadSnapshotStore.load")(function* (snapshotId: string) {
    yield* io(assertDirectories);
    const manifest = yield* io(() => readManifest(snapshotId), "corrupt").pipe(
      Effect.flatMap(validateManifest),
    );
    for (const asset of manifest.assets) yield* io(() => verifyAsset(asset), "corrupt");
    return manifest;
  });
  const load = (snapshotId: string) => lock.withPermits(1)(loadUnlocked(snapshotId));

  const putAsset = (input: Uint8Array) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const bytes = Uint8Array.from(input);
        if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) return yield* failure("corrupt");
        const sha256 = hash(bytes);
        const asset: CadStoredAsset = {
          sha256,
          byteLength: bytes.length,
          relativePath: `${sha256}.glb`,
          format: "glb",
        };
        yield* io(assertDirectories);
        const exists = yield* io(async () => {
          try {
            await NodeFSP.lstat(NodePath.join(assets, asset.relativePath));
            return true;
          } catch (error) {
            if (missing(error)) return false;
            throw error;
          }
        });
        if (exists) {
          const verified = yield* io(() => verifyAsset(asset), "corrupt").pipe(Effect.option);
          if (verified._tag === "Some") return asset;
          yield* io(async () => {
            const stat = await NodeFSP.lstat(NodePath.join(assets, asset.relativePath));
            if (!stat.isFile() || stat.isSymbolicLink()) throw failure("corrupt");
          });
          yield* checkReserve(bytes.length);
          yield* io(() => atomicWrite(NodePath.join(assets, asset.relativePath), bytes, true));
          return asset;
        }
        yield* checkReserve(bytes.length);
        yield* io(() => atomicWrite(NodePath.join(assets, asset.relativePath), bytes));
        return asset;
      }),
    );
  const publish = (input: CadSnapshotManifest) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const manifest = yield* Effect.try({
          try: () => decodeManifest(input),
          catch: () => failure("corrupt"),
        }).pipe(Effect.flatMap(validateManifest));
        const bytes = new TextEncoder().encode(encodeManifestJson(manifest));
        if (bytes.length > MAX_MANIFEST_BYTES) return yield* failure("corrupt");
        yield* io(assertDirectories);
        yield* io(async () => {
          try {
            await NodeFSP.lstat(NodePath.join(retired, `${manifest.snapshotId}.json`));
          } catch (error) {
            if (missing(error)) return;
            throw error;
          }
          throw failure("busy");
        });
        for (const asset of manifest.assets) yield* io(() => verifyAsset(asset), "corrupt");
        const existing = yield* io(async () => {
          try {
            return await readFile(manifestPath(manifest.snapshotId), MAX_MANIFEST_BYTES);
          } catch (error) {
            if (missing(error)) return null;
            throw error;
          }
        });
        if (existing) {
          if (!Buffer.from(bytes).equals(existing)) return yield* failure("corrupt");
          return;
        }
        yield* checkReserve(bytes.length);
        yield* io(() => atomicWrite(manifestPath(manifest.snapshotId), bytes));
      }),
    );
  const list = () =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* io(assertDirectories);
        const result: CadSnapshotSummary[] = [];
        for (const name of yield* io(() => NodeFSP.readdir(manifests))) {
          if (!name.endsWith(".json")) return yield* failure("corrupt");
          const manifest = yield* io(() => readManifest(name.slice(0, -5)), "corrupt").pipe(
            Effect.flatMap(validateManifest),
          );
          result.push({
            snapshotId: manifest.snapshotId,
            projectId: manifest.projectId,
            rootId: manifest.rootId,
            createdAt: manifest.createdAt,
            byteLength: manifest.assets.reduce((sum, asset) => sum + asset.byteLength, 0),
          });
        }
        return result;
      }),
    );
  const remove = (snapshotIds: readonly string[], protectedIds: readonly string[]) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* io(assertDirectories);
        const targets = yield* Effect.try({
          try: () => new Set(snapshotIds.map((id) => decodeSnapshotId(id))),
          catch: () => failure("corrupt"),
        });
        if (
          acquisitions > 0 ||
          [...targets].some((id) => pins.has(id) || protectedIds.includes(id))
        )
          return yield* failure("busy");
        const removedHashes = new Set<string>();
        const retainedHashes = new Set<string>();
        let canCollect = true;
        for (const directory of [manifests, retired])
          for (const name of yield* io(() => NodeFSP.readdir(directory))) {
            const id = name.slice(0, -5);
            const manifest = yield* (
              name.endsWith(".json")
                ? io(() => readManifest(id, directory), "corrupt").pipe(
                    Effect.flatMap(validateManifest),
                  )
                : Effect.fail(failure("corrupt"))
            ).pipe(Effect.option);
            if (manifest._tag === "None") {
              canCollect = false;
              continue;
            }
            for (const asset of manifest.value.assets)
              (targets.has(id) ? removedHashes : retainedHashes).add(asset.sha256);
          }
        yield* io(async () => {
          for (const id of targets) {
            const path = manifestPath(id);
            try {
              const stat = await NodeFSP.lstat(path);
              if (!stat.isFile() || stat.isSymbolicLink()) throw failure("corrupt");
              const ledger = NodePath.join(retired, `${id}.json`);
              try {
                await NodeFSP.link(path, ledger);
              } catch (error) {
                if (!(Predicate.isObject(error) && "code" in error && error.code === "EEXIST"))
                  throw error;
                if (
                  !(await readFile(path, MAX_MANIFEST_BYTES)).equals(
                    await readFile(ledger, MAX_MANIFEST_BYTES),
                  )
                )
                  throw failure("corrupt");
              }
              await NodeFSP.unlink(path);
            } catch (error) {
              if (!missing(error)) throw error;
            }
          }
          if (!canCollect) throw failure("corrupt");
          if (canCollect)
            for (const sha of removedHashes)
              if (!retainedHashes.has(sha)) {
                const path = NodePath.join(assets, `${decodeHash(sha)}.glb`);
                try {
                  const stat = await NodeFSP.lstat(path);
                  if (!stat.isFile() || stat.isSymbolicLink()) throw failure("corrupt");
                  await NodeFSP.unlink(path);
                } catch (error) {
                  if (!missing(error)) throw error;
                }
              }
          for (const id of targets) {
            try {
              await NodeFSP.unlink(NodePath.join(retired, `${id}.json`));
            } catch (error) {
              if (!missing(error)) throw error;
            }
          }
        });
      }),
    );
  const withPinned: CadSnapshotStoreShape["withPinned"] = (snapshotId, use) =>
    Effect.acquireUseRelease(
      lock.withPermits(1)(
        loadUnlocked(snapshotId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pins.set(snapshotId, (pins.get(snapshotId) ?? 0) + 1);
            }),
          ),
        ),
      ),
      (manifest) => {
        const indexed = new Map(manifest.assets.map((asset) => [asset.sha256, asset]));
        let open = true;
        return use(manifest, (sha256) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (!open) return yield* failure("busy");
              yield* io(assertDirectories);
              const asset = indexed.get(sha256);
              if (!asset) return yield* failure("corrupt");
              return yield* io(() => verifyAsset(asset), "corrupt");
            }),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              open = false;
            }),
          ),
        );
      },
      () =>
        lock.withPermits(1)(
          Effect.sync(() => {
            const count = (pins.get(snapshotId) ?? 1) - 1;
            if (count === 0) pins.delete(snapshotId);
            else pins.set(snapshotId, count);
          }),
        ),
    );
  const withAcquisition: CadSnapshotStoreShape["withAcquisition"] = (effect) =>
    Effect.acquireUseRelease(
      lock.withPermits(1)(
        Effect.sync(() => {
          acquisitions++;
        }),
      ),
      () => effect,
      () =>
        lock.withPermits(1)(
          Effect.sync(() => {
            acquisitions--;
          }).pipe(Effect.andThen(retryOrphanCleanup())),
        ),
    );
  return CadSnapshotStore.of({
    checkReserve,
    findGeometry,
    putAsset,
    publish,
    load,
    readAsset: (snapshotId, sha256) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* io(assertDirectories);
          const manifest = yield* io(() => readManifest(snapshotId), "corrupt").pipe(
            Effect.flatMap(validateManifest),
          );
          const asset = manifest.assets.find((candidate) => candidate.sha256 === sha256);
          if (!asset) return yield* failure("corrupt");
          return yield* io(() => verifyAsset(asset), "corrupt");
        }),
      ),
    list,
    remove,
    withPinned,
    withAcquisition,
  });
});
export const layer = Layer.effect(CadSnapshotStore, make).pipe(Layer.provide(diskSpaceLayer));
