// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CadViewError, type CadSnapshotManifest } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/unstable/http";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { CadPanel } from "./CadPanel.ts";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";
import { ServerConfig } from "../config.ts";
import { preparedCadTransfers } from "./CadPreparedTransfer.ts";
import { routeLayer } from "./panelHttp.ts";

const sceneId = "00000000-0000-4000-8000-000000000001";
const token = "00000000-0000-4000-8000-000000000002";
const payload = new Uint8Array(64 * 1024).fill(7);
const removeTestState = async (stateDir: string) => {
  if (
    NodePath.dirname(stateDir) !== NodePath.resolve(NodeOS.tmpdir()) ||
    !NodePath.basename(stateDir).startsWith("cad-transfer-http-")
  )
    throw new Error("Unsafe test cleanup");
  await NodeFSP.rm(stateDir, { recursive: true, force: true });
};
const manifest = {
  snapshotId: "00000000-0000-4000-8000-000000000003",
  assets: [
    {
      sha256: "a".repeat(64),
      byteLength: payload.byteLength,
      relativePath: `${"a".repeat(64)}.glb`,
      format: "glb",
    },
  ],
} as unknown as CadSnapshotManifest;

describe("CAD panel binary route", () => {
  beforeEach(() => preparedCadTransfers.clear());

  it("finishes one independently pinned preparation when its first scene closes and another joins", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cad-transfer-http-"));
    const snapshot = {
      ...manifest,
      assets: [
        {
          ...manifest.assets[0]!,
          sha256: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
        },
      ],
    };
    const secondId = "00000000-0000-4000-8000-000000000004";
    const firstReleased = Deferred.makeUnsafe<void>();
    const secondReleased = Deferred.makeUnsafe<void>();
    let firstOpen = true;
    let pins = 0;
    let pinned = false;
    let entered!: () => void;
    let secondEntered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const joined = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstScene = {
      cancel: firstReleased,
      released: firstReleased,
      ticket: { sceneId, token },
      manifest: snapshot,
      readAsset: () =>
        firstOpen
          ? Effect.succeed(payload)
          : Effect.fail(new CadViewError({ reason: "capability-unavailable" })),
    };
    const secondScene = {
      ...firstScene,
      cancel: secondReleased,
      released: secondReleased,
      ticket: { sceneId: secondId, token },
      readAsset: () => Effect.succeed(payload),
    };
    const panel = CadPanel.of({
      watch: () => Stream.empty,
      scene: () => Stream.empty,
      releaseProject: () => Effect.void,
      read: (ticket) => {
        if (ticket.token !== token || (ticket.sceneId === sceneId && !firstOpen))
          return Effect.fail(new CadViewError({ reason: "capability-unavailable" }));
        if (ticket.sceneId === secondId) {
          secondEntered();
          return Effect.succeed(secondScene);
        }
        return Effect.succeed(firstScene);
      },
    });
    const unused = () => Effect.die("Unexpected store operation");
    const store = CadSnapshotStore.of({
      checkReserve: unused,
      findGeometry: unused,
      putAsset: unused,
      publish: unused,
      load: unused,
      readAsset: unused,
      list: unused,
      remove: unused,
      withAcquisition: (effect) => effect,
      withPinned: (_id, use) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            pins++;
            pinned = true;
            entered();
          }),
          () =>
            Effect.promise(() => gate).pipe(
              Effect.andThen(
                use(snapshot, () =>
                  Effect.sync(() => {
                    expect(pinned).toBe(true);
                    return payload;
                  }),
                ),
              ),
            ),
          () =>
            Effect.sync(() => {
              pinned = false;
            }),
        ),
    });
    const app = HttpRouter.toWebHandler(
      routeLayer.pipe(
        Layer.provideMerge(Layer.succeed(CadPanel, panel)),
        Layer.provideMerge(Layer.succeed(CadSnapshotStore, store)),
        Layer.provideMerge(Layer.succeed(ServerConfig, { stateDir } as ServerConfig["Service"])),
        Layer.provideMerge(NodeHttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
      { disableLogger: true },
    );
    const controller = new AbortController();
    const request = (id: string, signal?: AbortSignal) =>
      app.handler(
        new Request(`http://localhost/api/cad-panel/${id}/transfer-index`, {
          headers: { "x-cad-panel-token": token },
          ...(signal ? { signal } : {}),
        }),
      );
    try {
      const initial = request(sceneId, controller.signal).catch(() => undefined);
      await started;
      const second = request(secondId);
      await joined;
      firstOpen = false;
      Deferred.doneUnsafe(firstReleased, Effect.void);
      controller.abort();
      expect(pinned).toBe(true);
      release();
      const response = await second;
      expect(response.status).toBe(200);
      expect(pins).toBe(1);
      expect(pinned).toBe(false);
      await initial;
      expect((await request(sceneId)).status).toBe(410);
    } finally {
      release();
      Deferred.doneUnsafe(firstReleased, Effect.void);
      Deferred.doneUnsafe(secondReleased, Effect.void);
      await app.dispose();
      await removeTestState(stateDir);
    }
  });

  it("authorizes persisted transfer indexes and every range, with exact negotiated fallback bytes", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cad-transfer-http-"));
    let reads = 0;
    let sourcePins = 0;
    const snapshot = {
      ...manifest,
      assets: [
        {
          ...manifest.assets[0]!,
          sha256: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
        },
      ],
    };
    const panel = CadPanel.of({
      watch: () => Stream.empty,
      scene: () => Stream.empty,
      releaseProject: () => Effect.void,
      read: (ticket) =>
        ticket.token !== token
          ? Effect.fail(new CadViewError({ reason: "capability-unavailable" }))
          : Effect.succeed({
              cancel: undefined as never,
              released: undefined as never,
              ticket,
              manifest: snapshot,
              readAsset: () => {
                reads++;
                return Effect.succeed(payload);
              },
            }),
    });
    const unused = () => Effect.die("Unexpected store operation");
    const sourceStore = CadSnapshotStore.of({
      checkReserve: unused,
      findGeometry: unused,
      putAsset: unused,
      publish: unused,
      load: unused,
      readAsset: unused,
      list: unused,
      remove: unused,
      withAcquisition: (effect) => effect,
      withPinned: (_id, use) => {
        sourcePins++;
        return use(snapshot, () => {
          reads++;
          return Effect.succeed(payload);
        });
      },
    });
    const app = HttpRouter.toWebHandler(
      routeLayer.pipe(
        Layer.provideMerge(Layer.succeed(CadPanel, panel)),
        Layer.provideMerge(Layer.succeed(CadSnapshotStore, sourceStore)),
        Layer.provideMerge(Layer.succeed(ServerConfig, { stateDir } as ServerConfig["Service"])),
        Layer.provideMerge(NodeHttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
      { disableLogger: true },
    );
    const base = `http://localhost/api/cad-panel/${sceneId}`;
    const request = (NodePath: string, allowed = true, encoding = "br") =>
      app.handler(
        new Request(`${base}/${NodePath}`, {
          headers: {
            "x-cad-panel-token": allowed ? token : "00000000-0000-4000-8000-000000000099",
            "accept-encoding": encoding,
          },
        }),
      );
    try {
      expect((await request("transfer-index", false)).status).toBe(410);
      expect(reads).toBe(0);
      const indexResponse = await request("transfer-index");
      expect(indexResponse.status).toBe(200);
      expect(indexResponse.headers.get("cache-control")).toBe("no-store");
      const artifact = (await indexResponse.json()) as {
        identity: string;
        index: { byteLength: number };
      };
      const preparedReads = reads;
      expect(preparedReads).toBeGreaterThan(0);
      const range = `transfer?identity=${artifact.identity}&start=0&end=${artifact.index.byteLength - 1}`;
      expect((await request(range, false)).status).toBe(410);
      expect(reads).toBe(preparedReads);
      const compressed = await request(range);
      expect(compressed.status).toBe(200);
      expect(compressed.headers.get("content-encoding")).toBe("br");
      expect(compressed.headers.get("x-cad-bundle-range")).toBe(
        `bytes 0-${payload.byteLength - 1}/${payload.byteLength}`,
      );
      expect(NodeZlib.brotliDecompressSync(await compressed.arrayBuffer()).equals(payload)).toBe(
        true,
      );
      const fallback = await request(range, true, "gzip");
      expect(fallback.headers.get("content-encoding")).toBe("gzip");
      expect(NodeZlib.gunzipSync(await fallback.arrayBuffer()).equals(payload)).toBe(true);
      expect((await request(`transfer?identity=${artifact.identity}&start=1&end=2`)).status).toBe(
        416,
      );
      expect((await request(`transfer?identity=${"f".repeat(64)}&start=0&end=2`)).status).toBe(404);
      expect((await request("transfer-index")).status).toBe(200);
      expect(reads).toBe(preparedReads);
      expect(sourcePins).toBe(1);
    } finally {
      await app.dispose();
      await removeTestState(stateDir);
    }
  });

  it("authorizes before reading and serves exact prepared Brotli ranges without public caching", async () => {
    let assetReads = 0;
    const panel = CadPanel.of({
      watch: () => Stream.empty,
      scene: () => Stream.empty,
      releaseProject: () => Effect.void,
      read: (ticket) => {
        if (ticket.token !== token)
          return Effect.fail(new CadViewError({ reason: "capability-unavailable" }));
        return Effect.succeed({
          cancel: undefined as never,
          released: undefined as never,
          ticket,
          manifest,
          readAsset: () => {
            assetReads++;
            return Effect.succeed(payload);
          },
        });
      },
    });
    const app = HttpRouter.toWebHandler(
      routeLayer.pipe(
        Layer.provideMerge(Layer.succeed(CadPanel, panel)),
        Layer.provideMerge(NodeHttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
      { disableLogger: true },
    );
    const endpoint = `http://localhost/api/cad-panel/${sceneId}/bundle?start=0&end=${payload.byteLength - 1}`;
    try {
      const denied = await app.handler(
        new Request(endpoint, {
          headers: {
            "x-cad-panel-token": "00000000-0000-4000-8000-000000000099",
            "accept-encoding": "br",
          },
        }),
      );
      expect(denied.status).toBe(410);
      expect(assetReads).toBe(0);

      const response = await app.handler(
        new Request(endpoint, {
          headers: { "x-cad-panel-token": token, "accept-encoding": "br, gzip" },
        }),
      );
      const encoded = new Uint8Array(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("br");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      expect(response.headers.get("x-cad-bundle-range")).toBe(
        `bytes 0-${payload.byteLength - 1}/${payload.byteLength}`,
      );
      expect(Uint8Array.from(NodeZlib.brotliDecompressSync(encoded))).toEqual(payload);
      expect(assetReads).toBe(1);

      const cached = await app.handler(
        new Request(endpoint, {
          headers: { "x-cad-panel-token": token, "accept-encoding": "br" },
        }),
      );
      expect(cached.status).toBe(200);
      expect(assetReads).toBe(1);
    } finally {
      await app.dispose();
    }
  });

  it("keeps gzip fallback and rejects oversized ranges before asset reads", async () => {
    let assetReads = 0;
    const panel = CadPanel.of({
      watch: () => Stream.empty,
      scene: () => Stream.empty,
      releaseProject: () => Effect.void,
      read: (ticket) =>
        Effect.succeed({
          cancel: undefined as never,
          released: undefined as never,
          ticket,
          manifest,
          readAsset: () => {
            assetReads++;
            return Effect.succeed(payload);
          },
        }),
    });
    const app = HttpRouter.toWebHandler(
      routeLayer.pipe(
        Layer.provideMerge(Layer.succeed(CadPanel, panel)),
        Layer.provideMerge(NodeHttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
      { disableLogger: true },
    );
    const base = `http://localhost/api/cad-panel/${sceneId}/bundle`;
    try {
      const fallback = await app.handler(
        new Request(`${base}?start=0&end=${payload.byteLength - 1}`, {
          headers: { "x-cad-panel-token": token, "accept-encoding": "br;q=0, gzip" },
        }),
      );
      expect(fallback.headers.get("content-encoding")).toBe("gzip");
      expect(Uint8Array.from(NodeZlib.gunzipSync(await fallback.arrayBuffer()))).toEqual(payload);

      const rejected = await app.handler(
        new Request(`${base}?start=0&end=${4 * 1024 ** 2}`, {
          headers: { "x-cad-panel-token": token, "accept-encoding": "br" },
        }),
      );
      expect(rejected.status).toBe(416);
      expect(assetReads).toBe(1);
    } finally {
      await app.dispose();
    }
  });
});
