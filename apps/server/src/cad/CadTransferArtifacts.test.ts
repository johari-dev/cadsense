// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  CadTransferArtifacts,
  cadTransferIdentity,
  CAD_TRANSFER_RANGE_BYTES,
} from "./CadTransferArtifacts.ts";
import { encodeCadTransfer } from "./CadTransferEncoder.ts";

const directories: string[] = [];
const temporary = async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "cad-transfer-artifacts-"),
  );
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (
      NodePath.dirname(directory) !== NodePath.resolve(NodeOS.tmpdir()) ||
      !NodePath.basename(directory).startsWith("cad-transfer-artifacts-")
    )
      throw new Error("Unsafe test cleanup");
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
const fixture = (size = 16 * 1024, fill = 7) => {
  const bytes = new Uint8Array(size).fill(fill);
  const assets = [
    {
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    },
  ];
  return { bytes, assets, read: async () => bytes };
};

describe("persistent CAD transfer artifacts", () => {
  it("retains an active scene's artifact under disk pressure, then permits eviction after release", async () => {
    const stateDir = await temporary();
    const first = fixture(2000, 1);
    const next = fixture(2000, 2);
    const store = new CadTransferArtifacts(stateDir, { reserveBytes: 0, maxDiskBytes: 5000 });
    const artifact = await store.get(first.assets, first.read);
    const owner = {};
    let release!: () => void;
    let subscriptions = 0;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const whenReleased = () => {
      subscriptions++;
      return released;
    };
    store.retain(first.assets, owner, whenReleased);
    store.retain(first.assets, owner, whenReleased);
    expect(subscriptions).toBe(1);
    await expect(store.get(next.assets, next.read)).rejects.toThrow("disk cache budget");
    expect(
      (
        await store.range(first.assets, artifact.identity, 0, first.bytes.length - 1, false)
      ).bytes.equals(first.bytes),
    ).toBe(true);
    release();
    await released;
    await Promise.resolve();
    store.retain(first.assets, owner, whenReleased);
    expect(subscriptions).toBe(1);
    const replacement = await store.get(next.assets, next.read);
    expect(await NodeFSP.readdir(NodePath.join(stateDir, "cad", "transfers"))).toEqual([
      replacement.identity,
    ]);
  });

  it("overlaps at most three compression jobs and publishes ranges in source order", async () => {
    const stateDir = await temporary();
    const source = fixture(5 * CAD_TRANSFER_RANGE_BYTES + 100);
    let active = 0;
    let maximum = 0;
    let started = 0;
    let entered!: () => void;
    let release!: () => void;
    const threeStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new CadTransferArtifacts(stateDir, {
      reserveBytes: 0,
      compress: async (bytes) => {
        maximum = Math.max(maximum, ++active);
        if (++started === 3) entered();
        try {
          await gate;
          return NodeZlib.brotliCompressSync(bytes, {
            params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 1 },
          });
        } finally {
          active--;
        }
      },
    });
    const pending = store.get(source.assets, source.read);
    await threeStarted;
    try {
      expect(active).toBe(3);
      expect(maximum).toBe(3);
    } finally {
      release();
    }
    const artifact = await pending;
    expect(active).toBe(0);
    expect(maximum).toBe(3);
    const metadata = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(stateDir, "cad", "transfers", artifact.identity, "index.json"),
        "utf8",
      ),
    ) as { parts: { start: number }[] };
    expect(metadata.parts.map((part) => part.start)).toEqual(
      Array.from({ length: 6 }, (_, i) => i * CAD_TRANSFER_RANGE_BYTES),
    );
    const last = await store.range(
      source.assets,
      artifact.identity,
      5 * CAD_TRANSFER_RANGE_BYTES,
      source.bytes.length - 1,
      true,
    );
    expect(
      NodeZlib.brotliDecompressSync(last.bytes).equals(
        source.bytes.subarray(5 * CAD_TRANSFER_RANGE_BYTES),
      ),
    ).toBe(true);
  });

  it("settles outstanding writers before removing staging after a compression failure", async () => {
    const stateDir = await temporary();
    const source = fixture(3 * CAD_TRANSFER_RANGE_BYTES);
    let started = 0;
    let active = 0;
    let entered!: () => void;
    let rejectFirst!: () => void;
    let releaseOthers!: () => void;
    const threeStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fail = new Promise<void>((resolve) => {
      rejectFirst = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOthers = resolve;
    });
    const store = new CadTransferArtifacts(stateDir, {
      reserveBytes: 0,
      compress: async (bytes) => {
        const first = started++ === 0;
        active++;
        if (started === 3) entered();
        try {
          if (first) {
            await fail;
            throw new Error("Compression failed");
          }
          await gate;
          return NodeZlib.brotliCompressSync(bytes, {
            params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 1 },
          });
        } finally {
          active--;
        }
      },
    });
    let settled = false;
    const pending = store.get(source.assets, source.read).finally(() => {
      settled = true;
    });
    const failure = expect(pending).rejects.toThrow("Compression failed");
    await threeStarted;
    rejectFirst();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    try {
      expect(settled).toBe(false);
      expect(active).toBe(2);
      expect(await NodeFSP.readdir(NodePath.join(stateDir, "cad", "transfers"))).toHaveLength(1);
    } finally {
      releaseOthers();
    }
    await failure;
    expect(active).toBe(0);
    expect(await NodeFSP.readdir(NodePath.join(stateDir, "cad", "transfers"))).toEqual([]);
  });

  it("serves a prepared model while another model is being encoded", async () => {
    const stateDir = await temporary();
    const warm = fixture(64, 1);
    const cold = fixture(64, 2);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new CadTransferArtifacts(stateDir, {
      reserveBytes: 0,
      encode: async (...args) => {
        if (args[0][0]!.sha256 === cold.assets[0]!.sha256) {
          entered();
          await gate;
        }
        return encodeCadTransfer(...args);
      },
    });
    const expected = await store.get(warm.assets, warm.read);
    const pending = store.get(cold.assets, cold.read);
    await started;
    try {
      const result = await Promise.race([
        store.get(warm.assets, warm.read),
        new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
      ]);
      expect(result).toEqual(expected);
    } finally {
      release();
      await pending;
    }
  });

  it("coalesces preparation and serves exact raw/Brotli bytes after a process restart without encoding", async () => {
    const stateDir = await temporary();
    const source = fixture(CAD_TRANSFER_RANGE_BYTES + 100);
    let encodes = 0;
    const store = new CadTransferArtifacts(stateDir, {
      reserveBytes: 0,
      encode: (...args) => {
        encodes++;
        return encodeCadTransfer(...args);
      },
    });
    const [first, joined] = await Promise.all([
      store.get(source.assets, source.read),
      store.get(source.assets, source.read),
    ]);
    expect(joined).toEqual(first);
    expect(encodes).toBe(1);
    const fresh = new CadTransferArtifacts(stateDir, {
      reserveBytes: 0,
      encode: async () => {
        throw new Error("Must reuse disk artifact");
      },
    });
    expect(
      await fresh.get(source.assets, async () => {
        throw new Error("Must not reread source");
      }),
    ).toEqual(first);
    const head = await fresh.range(
      source.assets,
      first.identity,
      0,
      CAD_TRANSFER_RANGE_BYTES - 1,
      true,
    );
    const tail = await fresh.range(
      source.assets,
      first.identity,
      CAD_TRANSFER_RANGE_BYTES,
      source.bytes.length - 1,
      false,
    );
    expect(
      NodeZlib.brotliDecompressSync(head.bytes).equals(
        source.bytes.subarray(0, CAD_TRANSFER_RANGE_BYTES),
      ),
    ).toBe(true);
    expect(tail.bytes).toEqual(Buffer.from(source.bytes.subarray(CAD_TRANSFER_RANGE_BYTES)));
  });

  it("never publishes partial output and retries failed preparation", async () => {
    const stateDir = await temporary();
    const source = fixture();
    let calls = 0;
    const store = new CadTransferArtifacts(stateDir, {
      reserveBytes: 0,
      encode: async (...args) => {
        calls++;
        if (calls === 1) {
          await args[2](source.bytes);
          throw new Error("Source went away");
        }
        return encodeCadTransfer(...args);
      },
    });
    await expect(store.get(source.assets, source.read)).rejects.toThrow("Source went away");
    expect(await NodeFSP.readdir(NodePath.join(stateDir, "cad", "transfers"))).toEqual([]);
    expect((await store.get(source.assets, source.read)).identity).toBe(
      cadTransferIdentity(source.assets),
    );
    expect(calls).toBe(2);
  });

  it("rejects stale identities and invalid ranges, detects corrupt bytes, then regenerates", async () => {
    const stateDir = await temporary();
    const source = fixture();
    const store = new CadTransferArtifacts(stateDir, { reserveBytes: 0 });
    const artifact = await store.get(source.assets, source.read);
    await expect(
      store.range(fixture(64, 9).assets, artifact.identity, 0, source.bytes.length - 1, false),
    ).rejects.toThrow("identity mismatch");
    await expect(store.range(source.assets, artifact.identity, 1, 2, false)).rejects.toThrow(
      "Invalid CAD transfer range",
    );
    await expect(
      store.range(source.assets, artifact.identity, 0, source.bytes.length, false),
    ).rejects.toThrow("Invalid CAD transfer range");
    const rawPath = NodePath.join(stateDir, "cad", "transfers", artifact.identity, "0.raw");
    await NodeFSP.writeFile(rawPath, new Uint8Array(source.bytes.length));
    await expect(
      store.range(source.assets, artifact.identity, 0, source.bytes.length - 1, false),
    ).rejects.toThrow("Corrupt CAD transfer range");
    await store.get(source.assets, source.read);
    expect(
      (await store.range(source.assets, artifact.identity, 0, source.bytes.length - 1, false))
        .bytes,
    ).toEqual(Buffer.from(source.bytes));
  });

  it("rejects corrupt index metadata and safely rebuilds it", async () => {
    const stateDir = await temporary();
    const source = fixture();
    const store = new CadTransferArtifacts(stateDir, { reserveBytes: 0 });
    const artifact = await store.get(source.assets, source.read);
    await NodeFSP.writeFile(
      NodePath.join(stateDir, "cad", "transfers", artifact.identity, "index.json"),
      '{"identity":"wrong"}',
    );
    const fresh = new CadTransferArtifacts(stateDir, { reserveBytes: 0 });
    expect(await fresh.get(source.assets, source.read)).toEqual(artifact);
  });

  it("serializes distinct preparations and evicts older derived artifacts within the disk budget", async () => {
    const stateDir = await temporary();
    let active = 0;
    let maximum = 0;
    const encoded: string[] = [];
    const store = new CadTransferArtifacts(stateDir, {
      reserveBytes: 0,
      maxDiskBytes: 5000,
      encode: async (...args) => {
        encoded.push(cadTransferIdentity(args[0]));
        maximum = Math.max(maximum, ++active);
        try {
          return await encodeCadTransfer(...args);
        } finally {
          active--;
        }
      },
    });
    const sources = [fixture(2000, 1), fixture(2000, 2), fixture(2000, 3)];
    await Promise.all(sources.map((source) => store.get(source.assets, source.read)));
    expect(maximum).toBe(1);
    const remaining = await NodeFSP.readdir(NodePath.join(stateDir, "cad", "transfers"));
    expect(remaining).toContain(encoded.at(-1));
    expect(remaining).not.toContain(encoded[0]);
    let diskBytes = 0;
    for (const directory of remaining)
      for (const file of await NodeFSP.readdir(
        NodePath.join(stateDir, "cad", "transfers", directory),
      ))
        diskBytes += (
          await NodeFSP.stat(NodePath.join(stateDir, "cad", "transfers", directory, file))
        ).size;
    expect(diskBytes).toBeLessThanOrEqual(5000);
  });

  it("does not follow a transfer directory junction outside its state directory", async () => {
    const stateDir = await temporary();
    const outside = await temporary();
    await NodeFSP.mkdir(NodePath.join(stateDir, "cad"));
    await NodeFSP.symlink(outside, NodePath.join(stateDir, "cad", "transfers"), "junction");
    const source = fixture();
    await expect(
      new CadTransferArtifacts(stateDir, { reserveBytes: 0 }).get(source.assets, source.read),
    ).rejects.toThrow("Unsafe CAD transfer directory");
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });
});
