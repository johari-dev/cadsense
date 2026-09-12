// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import {
  acceptsPreparedCadEncoding,
  createCadBundlePlan,
  makePreparedCadTransferCache,
} from "./CadPreparedTransfer.ts";

const asset = (sha256: string, byteLength: number) => ({ sha256, byteLength });
const bytes = (value: string) => new TextEncoder().encode(value);
const pending = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const retain = (
  cache: ReturnType<typeof makePreparedCadTransferCache>,
  plan: ReturnType<typeof createCadBundlePlan>,
) => {
  const released = pending();
  const owner = {};
  cache.retain(plan, owner, () => released.promise);
  return owner;
};
const emptyStats = {
  bytes: 0,
  pendingEntries: 0,
  readyEntries: 0,
  retainedIdentities: 0,
  warmJobs: 0,
};

describe("prepared CAD transfers", () => {
  it("deduplicates manifest assets and preserves their first-seen byte order", () => {
    const plan = createCadBundlePlan(
      {
        snapshotId: "snapshot-a",
        assets: [asset("a", 3), asset("b", 2), asset("a", 3)],
      },
      { rangeBytes: 4 },
    );

    expect(plan.totalBytes).toBe(5);
    expect(plan.ranges).toEqual([
      {
        start: 0,
        end: 3,
        slices: [
          { sha256: "a", byteLength: 3, start: 0, end: 3 },
          { sha256: "b", byteLength: 2, start: 0, end: 1 },
        ],
      },
      {
        start: 4,
        end: 4,
        slices: [{ sha256: "b", byteLength: 2, start: 1, end: 2 }],
      },
    ]);
  });

  it("recognizes Brotli without overriding an explicit zero quality", () => {
    expect(acceptsPreparedCadEncoding("gzip, deflate, br, zstd")).toBe(true);
    expect(acceptsPreparedCadEncoding("gzip, *;q=0.5")).toBe(true);
    expect(acceptsPreparedCadEncoding("gzip, br;q=0, *;q=1")).toBe(false);
    expect(acceptsPreparedCadEncoding("gzip")).toBe(false);
    expect(acceptsPreparedCadEncoding("not valid;q=wat")).toBe(false);
  });

  it("Brotli-encodes a range that reconstructs the exact source bytes", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 3), asset("b", 3)] },
      { rangeBytes: 4 },
    );
    const source = new Map([
      ["a", bytes("abc")],
      ["b", bytes("def")],
    ]);
    const cache = makePreparedCadTransferCache();
    retain(cache, plan);

    const encoded = await cache.get(plan, plan.ranges[0]!, async (sha256) => source.get(sha256)!);

    expect(Uint8Array.from(NodeZlib.brotliDecompressSync(encoded))).toEqual(bytes("abcd"));
  });

  it("coalesces concurrent preparation of the same immutable range", async () => {
    let reads = 0;
    let encodes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 4)] },
      { rangeBytes: 4 },
    );
    const cache = makePreparedCadTransferCache({
      encode: async (input) => {
        encodes++;
        await gate;
        return input;
      },
    });
    retain(cache, plan);
    const read = async () => {
      reads++;
      return bytes("abcd");
    };

    const first = cache.get(plan, plan.ranges[0]!, read);
    const second = cache.get(plan, plan.ranges[0]!, read);
    release();

    expect(await first).toEqual(bytes("abcd"));
    expect(await second).toEqual(bytes("abcd"));
    expect({ reads, encodes }).toEqual({ reads: 1, encodes: 1 });
  });

  it("bounds retained encoded bytes and entry count", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 12)] },
      { rangeBytes: 4 },
    );
    const cache = makePreparedCadTransferCache({
      maxBytes: 5,
      maxEntries: 2,
      encode: async (input) => input,
    });
    retain(cache, plan);
    const read = async () => bytes("abcdefghijkl");

    for (const range of plan.ranges) await cache.get(plan, range, read);

    expect(cache.stats()).toEqual({
      bytes: 4,
      pendingEntries: 0,
      readyEntries: 1,
      retainedIdentities: 1,
      warmJobs: 0,
    });
  });

  it("invalidates prepared ranges when a snapshot identity changes", async () => {
    const firstPlan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 4)] },
      { rangeBytes: 4 },
    );
    const secondPlan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("b", 4)] },
      { rangeBytes: 4 },
    );
    const cache = makePreparedCadTransferCache({ encode: async (input) => input });
    retain(cache, firstPlan);
    retain(cache, secondPlan);
    let reads = 0;

    const first = await cache.get(firstPlan, firstPlan.ranges[0]!, async () => {
      reads++;
      return bytes("aaaa");
    });
    const second = await cache.get(secondPlan, secondPlan.ranges[0]!, async () => {
      reads++;
      return bytes("bbbb");
    });

    expect(first).toEqual(bytes("aaaa"));
    expect(second).toEqual(bytes("bbbb"));
    expect(reads).toBe(2);
    expect(cache.stats()).toEqual({
      bytes: 4,
      pendingEntries: 0,
      readyEntries: 1,
      retainedIdentities: 2,
      warmJobs: 0,
    });
  });

  it("removes failed entries so a later request can retry", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 4)] },
      { rangeBytes: 4 },
    );
    const cache = makePreparedCadTransferCache({ encode: async (input) => input });
    retain(cache, plan);
    let reads = 0;
    const read = async () => {
      reads++;
      if (reads === 1) throw new Error("transient");
      return bytes("abcd");
    };

    await expect(cache.get(plan, plan.ranges[0]!, read)).rejects.toThrow("transient");
    await expect(cache.get(plan, plan.ranges[0]!, read)).resolves.toEqual(bytes("abcd"));
    expect(reads).toBe(2);
  });

  it("warms ranges with bounded concurrency", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 20)] },
      { rangeBytes: 4 },
    );
    let active = 0;
    let peak = 0;
    const cache = makePreparedCadTransferCache({
      warmConcurrency: 2,
      encode: async (input) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return input;
      },
    });
    const owner = retain(cache, plan);

    await cache.warm(plan, owner, async () => bytes("abcdefghijklmnopqrst"));

    expect(peak).toBe(2);
    expect(cache.stats()).toEqual({
      bytes: 20,
      pendingEntries: 0,
      readyEntries: 5,
      retainedIdentities: 1,
      warmJobs: 0,
    });
  });

  it("evicts an identity only after its final scene owner releases", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 4)] },
      { rangeBytes: 4 },
    );
    const cache = makePreparedCadTransferCache({ encode: async (input) => input });
    const first = pending();
    const second = pending();
    cache.retain(plan, {}, () => first.promise);
    cache.retain(plan, {}, () => second.promise);

    await cache.get(plan, plan.ranges[0]!, async () => bytes("abcd"));
    first.resolve();
    await Promise.resolve();
    expect(cache.stats()).toEqual({
      bytes: 4,
      pendingEntries: 0,
      readyEntries: 1,
      retainedIdentities: 1,
      warmJobs: 0,
    });

    second.resolve();
    await Promise.resolve();
    expect(cache.stats()).toEqual(emptyStats);
  });

  it("does not publish a pending preparation after the final owner releases", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 4)] },
      { rangeBytes: 4 },
    );
    const encoded = pending();
    const released = pending();
    const cache = makePreparedCadTransferCache({
      encode: async (input) => {
        await encoded.promise;
        return input;
      },
    });
    cache.retain(plan, {}, () => released.promise);

    const preparation = cache.get(plan, plan.ranges[0]!, async () => bytes("abcd"));
    await Promise.resolve();
    released.resolve();
    await Promise.resolve();
    expect(cache.stats()).toEqual(emptyStats);
    encoded.resolve();

    await expect(preparation).resolves.toEqual(bytes("abcd"));
    expect(cache.stats()).toEqual(emptyStats);
  });

  it("stops a warm loop when its scene ownership generation releases", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 12)] },
      { rangeBytes: 4 },
    );
    const encoded = pending();
    const released = pending();
    let encodes = 0;
    const cache = makePreparedCadTransferCache({
      warmConcurrency: 1,
      encode: async (input) => {
        encodes++;
        await encoded.promise;
        return input;
      },
    });
    const owner = {};
    cache.retain(plan, owner, () => released.promise);

    const warming = cache.warm(plan, owner, async () => bytes("abcdefghijkl"));
    await Promise.resolve();
    released.resolve();
    await Promise.resolve();
    encoded.resolve();
    await warming;

    expect(encodes).toBe(1);
    expect(cache.stats()).toEqual(emptyStats);
  });

  it("continues warming from a surviving owner when the first owner's read fails", async () => {
    const plan = createCadBundlePlan(
      { snapshotId: "snapshot-a", assets: [asset("a", 12)] },
      { rangeBytes: 4 },
    );
    const firstReleased = pending();
    const secondReleased = pending();
    const firstReadStarted = pending();
    const failFirstRead = pending();
    const firstOwner = {};
    const secondOwner = {};
    let firstReads = 0;
    let secondReads = 0;
    const cache = makePreparedCadTransferCache({
      warmConcurrency: 1,
      encode: async (input) => input,
    });
    cache.retain(plan, firstOwner, () => firstReleased.promise);
    cache.retain(plan, secondOwner, () => secondReleased.promise);

    const firstWarm = cache.warm(plan, firstOwner, async () => {
      firstReads++;
      firstReadStarted.resolve();
      await failFirstRead.promise;
      throw new Error("scene released");
    });
    await firstReadStarted.promise;
    const secondWarm = cache.warm(plan, secondOwner, async () => {
      secondReads++;
      return bytes("abcdefghijkl");
    });

    firstReleased.resolve();
    await Promise.resolve();
    failFirstRead.resolve();
    await Promise.all([firstWarm, secondWarm]);

    expect({ firstReads, secondReads }).toEqual({ firstReads: 1, secondReads: 3 });
    expect(cache.stats()).toEqual({
      bytes: 12,
      pendingEntries: 0,
      readyEntries: 3,
      retainedIdentities: 1,
      warmJobs: 0,
    });

    secondReleased.resolve();
    await Promise.resolve();
    expect(cache.stats()).toEqual(emptyStats);
  });

  it("releases per-snapshot metadata instead of retaining every snapshot ever served", async () => {
    const cache = makePreparedCadTransferCache({ encode: async (input) => input });

    for (let index = 0; index < 200; index++) {
      const plan = createCadBundlePlan(
        { snapshotId: `snapshot-${index}`, assets: [asset(`asset-${index}`, 4)] },
        { rangeBytes: 4 },
      );
      const released = pending();
      cache.retain(plan, {}, () => released.promise);
      await cache.get(plan, plan.ranges[0]!, async () => bytes("abcd"));
      released.resolve();
      await Promise.resolve();
    }

    expect(cache.stats()).toEqual(emptyStats);
  });
});
