// @effect-diagnostics nodeBuiltinImport:off
// Atomic checkpoints survive interruptions without publishing an incomplete CAD snapshot.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { CadHash, CadSnapshotDraft, CadSnapshotId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../config.ts";
import { CadSnapshotStore, CadSnapshotStoreError } from "../cad/CadSnapshotStore.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{24}$/));
export const OnshapeSyncCheckpoint = Schema.Union([
  Schema.Struct({
    phase: Schema.Literal("exporting"),
    revisionKey: CadHash,
    draft: CadSnapshotDraft,
    translationId: Id,
  }),
  Schema.Struct({
    phase: Schema.Literal("downloaded"),
    revisionKey: CadHash,
    draft: CadSnapshotDraft,
    sha256: CadHash,
    byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    phase: Schema.Literal("complete"),
    revisionKey: CadHash,
    snapshotId: CadSnapshotId,
  }),
]);
export type OnshapeSyncCheckpoint = typeof OnshapeSyncCheckpoint.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OnshapeSyncCheckpoint));
const encode = Schema.encodeSync(Schema.fromJsonString(OnshapeSyncCheckpoint));
const decodeKey = Schema.decodeUnknownSync(CadHash);
const MAX_CHECKPOINT_BYTES = 16 * 1024 ** 2;
export const MAX_EXPORT_BYTES = 128 * 1024 ** 2;
const missing = (error: unknown) =>
  Predicate.isObject(error) && "code" in error && error.code === "ENOENT";
const corrupt = () => new CadSnapshotStoreError({ reason: "corrupt" });
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface OnshapeSyncEntry {
  readonly read: () => Effect.Effect<OnshapeSyncCheckpoint | null, CadSnapshotStoreError>;
  readonly write: (checkpoint: OnshapeSyncCheckpoint) => Effect.Effect<void, CadSnapshotStoreError>;
  readonly readDownload: (
    checkpoint: Extract<OnshapeSyncCheckpoint, { phase: "downloaded" }>,
  ) => Effect.Effect<Uint8Array, CadSnapshotStoreError>;
  readonly saveDownload: (
    draft: CadSnapshotDraft,
    revisionKey: string,
    bytes: Uint8Array,
  ) => Effect.Effect<
    Extract<OnshapeSyncCheckpoint, { phase: "downloaded" }>,
    CadSnapshotStoreError
  >;
  readonly clear: () => Effect.Effect<void, CadSnapshotStoreError>;
}

export class OnshapeSyncState extends Context.Service<
  OnshapeSyncState,
  {
    readonly withEntry: <A, E, R>(
      key: string,
      use: (entry: OnshapeSyncEntry) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CadSnapshotStoreError, R>;
  }
>()("@cadsense/server/onshape/OnshapeSyncState") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const store = yield* CadSnapshotStore;
  const directory = NodePath.join(config.stateDir, "onshape-sync");
  // Serialize checkpoint ownership; no background task spends Onshape quota.
  const lock = yield* Semaphore.make(1);
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () => new CadSnapshotStoreError({ reason: "unavailable" }),
    });
  const assertDirectory = async () => {
    const stat = await NodeFSP.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt();
  };
  yield* io(async () => {
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory();
  });
  const readFile = async (path: string, limit: number) => {
    await assertDirectory();
    const stat = await NodeFSP.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw corrupt();
    const bytes = await NodeFSP.readFile(path);
    if (bytes.length > limit) throw corrupt();
    return bytes;
  };
  const writeFile = (path: string, bytes: Uint8Array) =>
    store.checkReserve(bytes.length).pipe(
      Effect.andThen(
        io(async () => {
          await assertDirectory();
          const temporary = NodePath.join(directory, `${NodeCrypto.randomUUID()}.tmp`);
          try {
            await NodeFSP.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
            await NodeFSP.rename(temporary, path);
          } finally {
            await NodeFSP.unlink(temporary).catch((error: unknown) => {
              if (!missing(error)) throw error;
            });
          }
        }),
      ),
      Effect.uninterruptible,
    );
  const withEntry: OnshapeSyncState["Service"]["withEntry"] = (key, use) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const safeKey = yield* Effect.try({ try: () => decodeKey(key), catch: corrupt });
        const jsonPath = NodePath.join(directory, `${safeKey}.json`);
        const downloadPath = NodePath.join(directory, `${safeKey}.bin`);
        const unlink = (path: string) =>
          io(async () => {
            await assertDirectory();
            await NodeFSP.unlink(path).catch((error: unknown) => {
              if (!missing(error)) throw error;
            });
          });
        const write: OnshapeSyncEntry["write"] = (checkpoint) =>
          Effect.gen(function* () {
            const bytes = yield* Effect.try({
              try: () => new TextEncoder().encode(encode(checkpoint)),
              catch: corrupt,
            });
            if (bytes.length > MAX_CHECKPOINT_BYTES) return yield* corrupt();
            yield* writeFile(jsonPath, bytes);
            if (checkpoint.phase === "complete") yield* unlink(downloadPath);
          });
        return yield* use({
          read: () =>
            io(async () => {
              try {
                return decode(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    await readFile(jsonPath, MAX_CHECKPOINT_BYTES),
                  ),
                );
              } catch (error) {
                if (missing(error)) return null;
                throw error;
              }
            }),
          write,
          readDownload: (checkpoint) =>
            Effect.gen(function* () {
              const bytes = yield* io(() => readFile(downloadPath, MAX_EXPORT_BYTES));
              if (bytes.length !== checkpoint.byteLength || digest(bytes) !== checkpoint.sha256)
                return yield* corrupt();
              return bytes;
            }),
          saveDownload: (draft, revisionKey, bytes) =>
            Effect.gen(function* () {
              if (bytes.length === 0 || bytes.length > MAX_EXPORT_BYTES) return yield* corrupt();
              yield* writeFile(downloadPath, bytes);
              const checkpoint = {
                phase: "downloaded" as const,
                revisionKey,
                draft,
                sha256: digest(bytes),
                byteLength: bytes.length,
              };
              yield* write(checkpoint);
              return checkpoint;
            }).pipe(Effect.uninterruptible),
          clear: () => unlink(jsonPath).pipe(Effect.andThen(unlink(downloadPath))),
        });
      }),
    );
  return OnshapeSyncState.of({ withEntry });
});

export const layer = Layer.effect(OnshapeSyncState, make);
