// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import {
  CAD_TRANSFER_VERSION,
  validateCadTransferIndex,
  type CadTransferIndex,
} from "@cadsense/shared/cadTransfer";
import { encodeCadTransfer } from "./CadTransferEncoder.ts";

export const CAD_TRANSFER_RANGE_BYTES = 4 * 1024 ** 2;
const MAX_DISK_BYTES = 1024 ** 3;
const DISK_RESERVE_BYTES = 2 * 1024 ** 3;
const MAX_INDEX_BYTES = 16 * 1024 ** 2;
const DIGEST = /^[a-f0-9]{64}$/;
type Asset = { readonly sha256: string; readonly byteLength: number };
type ReadAsset = (sha256: string) => Promise<Uint8Array>;
type Encoder = typeof encodeCadTransfer;
interface Part {
  readonly start: number;
  readonly end: number;
  readonly rawHash: string;
  readonly compressedHash: string;
  readonly compressedBytes: number;
}
export interface CadTransferArtifact {
  readonly identity: string;
  readonly index: CadTransferIndex;
}
interface StoredArtifact extends CadTransferArtifact {
  readonly parts: readonly Part[];
  readonly diskBytes: number;
}
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const compress = (bytes: Uint8Array): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    NodeZlib.brotliCompress(
      bytes,
      { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });

export const cadTransferIdentity = (assets: readonly Asset[]) => {
  const hash = NodeCrypto.createHash("sha256").update(
    `${CAD_TRANSFER_VERSION}:br5:r${CAD_TRANSFER_RANGE_BYTES}\n`,
  );
  for (const asset of assets) {
    if (
      !DIGEST.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byteLength) ||
      asset.byteLength <= 0
    )
      throw new Error("Invalid CAD transfer asset");
    hash.update(`${asset.sha256}:${asset.byteLength}\n`);
  }
  return hash.digest("hex");
};

/** Derived, disposable files only. Snapshot assets remain the source of truth. */
export class CadTransferArtifacts {
  readonly #root: string;
  readonly #stateDir: string;
  readonly #maxDiskBytes: number;
  readonly #reserveBytes: number;
  readonly #encode: Encoder;
  readonly #compress: typeof compress;
  readonly #pending = new Map<string, Promise<CadTransferArtifact>>();
  readonly #loaded = new Map<string, StoredArtifact>();
  readonly #retained = new Map<string, number>();
  readonly #owners = new WeakMap<object, Set<string>>();
  readonly #evicting = new Map<string, Promise<void>>();
  #queue: Promise<unknown> = Promise.resolve();
  #initialization: Promise<void> | undefined;

  constructor(
    stateDir: string,
    options: {
      readonly maxDiskBytes?: number;
      readonly reserveBytes?: number;
      readonly encode?: Encoder;
      readonly compress?: typeof compress;
    } = {},
  ) {
    this.#stateDir = NodePath.resolve(stateDir);
    this.#root = NodePath.join(this.#stateDir, "cad", "transfers");
    this.#maxDiskBytes = options.maxDiskBytes ?? MAX_DISK_BYTES;
    this.#reserveBytes = options.reserveBytes ?? DISK_RESERVE_BYTES;
    this.#encode = options.encode ?? encodeCadTransfer;
    this.#compress = options.compress ?? compress;
  }

  async #directory(path: string) {
    const stat = await NodeFSP.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe CAD transfer directory");
  }
  async #initialize() {
    await this.#directory(this.#stateDir);
    for (const directory of [NodePath.join(this.#stateDir, "cad"), this.#root]) {
      await NodeFSP.mkdir(directory).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
      await this.#directory(directory);
    }
    this.#initialization ??= (async () => {
      for (const name of await NodeFSP.readdir(this.#root)) {
        if (/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(name)) await this.#remove(name);
      }
    })();
    await this.#initialization;
  }
  async #read(path: string, maximum: number) {
    const stat = await NodeFSP.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
      throw new Error("Invalid CAD transfer file");
    const bytes = await NodeFSP.readFile(path);
    if (bytes.byteLength > maximum) throw new Error("Oversized CAD transfer file");
    return bytes;
  }
  async #load(identity: string, assets: readonly Asset[]): Promise<StoredArtifact> {
    const directory = NodePath.join(this.#root, identity);
    await this.#directory(directory);
    const value: unknown = JSON.parse(
      (await this.#read(NodePath.join(directory, "index.json"), MAX_INDEX_BYTES)).toString("utf8"),
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("identity" in value) ||
      value.identity !== identity ||
      !("index" in value) ||
      !("parts" in value) ||
      !Array.isArray(value.parts) ||
      !("diskBytes" in value)
    )
      throw new Error("Invalid CAD transfer metadata");
    const index = validateCadTransferIndex(value.index, assets);
    if (value.parts.length !== Math.ceil(index.byteLength / CAD_TRANSFER_RANGE_BYTES))
      throw new Error("Invalid CAD transfer range count");
    const parts: Part[] = [];
    let cursor = 0;
    let diskBytes = 0;
    for (const part of value.parts) {
      if (
        !part ||
        typeof part !== "object" ||
        part.start !== cursor ||
        part.end !== Math.min(cursor + CAD_TRANSFER_RANGE_BYTES, index.byteLength) - 1 ||
        !DIGEST.test(part.rawHash) ||
        !DIGEST.test(part.compressedHash) ||
        !Number.isSafeInteger(part.compressedBytes) ||
        part.compressedBytes <= 0 ||
        part.compressedBytes > CAD_TRANSFER_RANGE_BYTES + 1024
      )
        throw new Error("Invalid CAD transfer ranges");
      const rawBytes = part.end - part.start + 1;
      for (const [suffix, size] of [
        ["raw", rawBytes],
        ["br", part.compressedBytes],
      ] as const) {
        const stat = await NodeFSP.lstat(NodePath.join(directory, `${cursor}.${suffix}`));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size)
          throw new Error("Incomplete CAD transfer");
      }
      parts.push(part);
      diskBytes += rawBytes + part.compressedBytes;
      cursor = part.end + 1;
    }
    if (
      cursor !== index.byteLength ||
      diskBytes !== value.diskBytes ||
      diskBytes > this.#maxDiskBytes
    )
      throw new Error("Invalid CAD transfer size");
    return { identity, index, parts, diskBytes };
  }
  // Never follow directories or links while pruning disposable artifacts.
  async #remove(name: string) {
    if (!DIGEST.test(name) && !/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(name))
      throw new Error("Invalid transfer cleanup target");
    const directory = NodePath.join(this.#root, name);
    this.#loaded.delete(name);
    try {
      await this.#directory(directory);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const files = await NodeFSP.readdir(directory);
    for (const file of files) {
      if (file !== "index.json" && !/^\d+\.(raw|br)$/.test(file))
        throw new Error("Unexpected transfer file");
      const stat = await NodeFSP.lstat(NodePath.join(directory, file));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Unsafe transfer cleanup target");
    }
    for (const file of files) await NodeFSP.unlink(NodePath.join(directory, file));
    await NodeFSP.rmdir(directory);
  }
  async #diskBudget(keep: string) {
    const entries: { name: string; bytes: number; used: number }[] = [];
    for (const name of await NodeFSP.readdir(this.#root)) {
      if (!DIGEST.test(name) || name === keep) continue;
      const directory = NodePath.join(this.#root, name);
      await this.#directory(directory);
      let bytes = 0;
      let used = 0;
      for (const file of await NodeFSP.readdir(directory)) {
        if (file !== "index.json" && !/^\d+\.(raw|br)$/.test(file))
          throw new Error("Unexpected transfer file");
        const stat = await NodeFSP.lstat(NodePath.join(directory, file));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe transfer file");
        bytes += stat.size;
        if (file === "index.json") used = stat.mtimeMs;
      }
      entries.push({ name, bytes, used });
    }
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const remaining = entries.sort((a, b) => a.used - b.used);
    // One directory scan per preparation; callers serialize reservations.
    return async (additionalBytes: number) => {
      while (bytes + additionalBytes > this.#maxDiskBytes && remaining.length > 0) {
        const candidate = remaining.findIndex((entry) => !this.#retained.has(entry.name));
        if (candidate === -1) break;
        const entry = remaining.splice(candidate, 1)[0]!;
        // Mark the removal before its first filesystem await. A new reader must
        // wait for deletion and rebuild instead of receiving a disappearing index.
        const deletion = Promise.resolve().then(() => this.#remove(entry.name));
        this.#evicting.set(entry.name, deletion);
        try {
          await deletion;
        } finally {
          this.#evicting.delete(entry.name);
        }
        bytes -= entry.bytes;
      }
      if (bytes + additionalBytes > this.#maxDiskBytes)
        throw new Error("CAD transfer exceeds disk cache budget");
    };
  }

  retain(assets: readonly Asset[], owner: object, whenReleased: () => Promise<void>) {
    const identity = cadTransferIdentity(assets);
    let identities = this.#owners.get(owner);
    if (identities?.has(identity)) return;
    if (!identities) {
      identities = new Set();
      this.#owners.set(owner, identities);
    }
    // Keep this tombstone after release so a dead scene cannot retain again.
    identities.add(identity);
    this.#retained.set(identity, (this.#retained.get(identity) ?? 0) + 1);
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      const count = (this.#retained.get(identity) ?? 1) - 1;
      if (count === 0) this.#retained.delete(identity);
      else this.#retained.set(identity, count);
    };
    try {
      void whenReleased().then(release, release);
    } catch {
      release();
    }
  }

  get(
    assets: readonly Asset[],
    readAsset: ReadAsset,
    options: {
      readonly withSource?: (
        use: (readAsset: ReadAsset) => Promise<CadTransferArtifact>,
      ) => Promise<CadTransferArtifact>;
    } = {},
  ): Promise<CadTransferArtifact> {
    const identity = cadTransferIdentity(assets);
    const pending = this.#pending.get(identity);
    if (pending) return pending;
    const operation = (async () => {
      await this.#initialize();
      await this.#evicting.get(identity);
      try {
        const cached = await this.#load(identity, assets);
        if (this.#evicting.has(identity)) {
          await this.#evicting.get(identity);
          throw new Error("CAD transfer was evicted during lookup");
        }
        this.#loaded.set(identity, cached);
        const now = new Date();
        await NodeFSP.utimes(NodePath.join(this.#root, identity, "index.json"), now, now);
        return { identity, index: cached.index };
      } catch {
        /* Only missing or invalid artifacts join the preparation queue. */
      }
      const prepare = async (readSource: ReadAsset) => {
        await this.#remove(identity);
        const reserveDisk = await this.#diskBudget(identity);
        const temporaryName = `${identity}.${NodeCrypto.randomUUID()}.tmp`;
        const temporary = NodePath.join(this.#root, temporaryName);
        await NodeFSP.mkdir(temporary);
        let buffer = new Uint8Array(CAD_TRANSFER_RANGE_BYTES);
        let used = 0;
        let offset = 0;
        let diskBytes = 0;
        let pendingWriteBytes = 0;
        let firstFailure: unknown;
        let reservation: Promise<void> = Promise.resolve();
        const jobs: Promise<void>[] = [];
        const parts: Part[] = [];
        const flush = async () => {
          if (used === 0) return;
          const raw = buffer.subarray(0, used);
          const start = offset;
          offset += used;
          used = 0;
          buffer = new Uint8Array(0);
          const job = (async () => {
            const compressed = await this.#compress(raw);
            const writeBytes = raw.byteLength + compressed.byteLength;
            diskBytes += writeBytes;
            const allocated = diskBytes;
            reservation = reservation.then(() => reserveDisk(allocated));
            await reservation;
            pendingWriteBytes += writeBytes;
            try {
              const free = await NodeFSP.statfs(this.#root);
              if (free.bavail * free.bsize - pendingWriteBytes < this.#reserveBytes)
                throw new Error("Insufficient CAD transfer disk reserve");
              await NodeFSP.writeFile(NodePath.join(temporary, `${start}.raw`), raw, {
                flag: "wx",
                mode: 0o600,
              });
              await NodeFSP.writeFile(NodePath.join(temporary, `${start}.br`), compressed, {
                flag: "wx",
                mode: 0o600,
              });
              parts.push({
                start,
                end: start + raw.byteLength - 1,
                rawHash: digest(raw),
                compressedHash: digest(compressed),
                compressedBytes: compressed.byteLength,
              });
            } finally {
              pendingWriteBytes -= writeBytes;
            }
          })().catch((error: unknown) => {
            firstFailure ??=
              error instanceof Error ? error : new Error("CAD transfer preparation failed");
          });
          jobs.push(job);
          // Leave one default libuv worker free for verified asset reads.
          // At most 12 MiB of raw buffers span assembly and compression.
          if (jobs.length === 3) await jobs.shift();
          if (firstFailure !== undefined) throw firstFailure;
          buffer = new Uint8Array(CAD_TRANSFER_RANGE_BYTES);
        };
        try {
          const index = await this.#encode(assets, readSource, async (chunk) => {
            for (let start = 0; start < chunk.byteLength; ) {
              const count = Math.min(chunk.byteLength - start, buffer.byteLength - used);
              buffer.set(chunk.subarray(start, start + count), used);
              used += count;
              start += count;
              if (used === buffer.byteLength) await flush();
            }
          });
          await flush();
          buffer = new Uint8Array(0);
          await Promise.all(jobs);
          if (firstFailure !== undefined) throw firstFailure;
          parts.sort((a, b) => a.start - b.start);
          validateCadTransferIndex(index, assets);
          if (index.byteLength !== offset) throw new Error("CAD transfer encoder length mismatch");
          const stored: StoredArtifact = { identity, index, parts, diskBytes };
          const metadata = JSON.stringify(stored);
          if (Buffer.byteLength(metadata) > MAX_INDEX_BYTES)
            throw new Error("Oversized CAD transfer index");
          await reserveDisk(diskBytes + Buffer.byteLength(metadata));
          const free = await NodeFSP.statfs(this.#root);
          if (free.bavail * free.bsize - Buffer.byteLength(metadata) < this.#reserveBytes)
            throw new Error("Insufficient CAD transfer disk reserve");
          // Publish metadata last, then make the complete directory visible atomically.
          await NodeFSP.writeFile(NodePath.join(temporary, "index.json"), metadata, {
            flag: "wx",
            mode: 0o600,
          });
          await NodeFSP.rename(temporary, NodePath.join(this.#root, identity));
          this.#loaded.set(identity, stored);
          return { identity, index };
        } finally {
          // Failed source reads or compression must settle every outstanding
          // writer before removing staging files or releasing the source pin.
          await Promise.all(jobs);
          await this.#remove(temporaryName);
        }
      };
      const preparation = this.#queue
        .catch(() => undefined)
        .then(() => (options.withSource ? options.withSource(prepare) : prepare(readAsset)));
      this.#queue = preparation;
      return preparation;
    })();
    this.#pending.set(identity, operation);
    void operation.finally(() => this.#pending.delete(identity)).catch(() => undefined);
    return operation;
  }

  async range(
    assets: readonly Asset[],
    identity: string,
    start: number,
    end: number,
    brotli: boolean,
  ) {
    if (!DIGEST.test(identity) || cadTransferIdentity(assets) !== identity)
      throw new Error("CAD transfer identity mismatch");
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end - start + 1 > CAD_TRANSFER_RANGE_BYTES ||
      start % CAD_TRANSFER_RANGE_BYTES !== 0
    )
      throw new RangeError("Invalid CAD transfer range");
    await this.#initialize();
    const artifact = this.#loaded.get(identity) ?? (await this.#load(identity, assets));
    const part = artifact.parts.find(
      (candidate) => candidate.start === start && candidate.end === end,
    );
    if (!part) throw new RangeError("Invalid CAD transfer range");
    const directory = NodePath.join(this.#root, identity);
    await this.#directory(directory);
    const bytes = await this.#read(
      NodePath.join(directory, `${start}.${brotli ? "br" : "raw"}`),
      CAD_TRANSFER_RANGE_BYTES + 1024,
    );
    if (digest(bytes) !== (brotli ? part.compressedHash : part.rawHash)) {
      await this.#remove(identity);
      throw new Error("Corrupt CAD transfer range");
    }
    return { bytes, byteLength: artifact.index.byteLength };
  }
}

const stores = new Map<string, CadTransferArtifacts>();
export const cadTransferArtifacts = (stateDir: string) => {
  const key = NodePath.resolve(stateDir);
  let store = stores.get(key);
  if (!store) {
    store = new CadTransferArtifacts(key);
    stores.set(key, store);
  }
  return store;
};
