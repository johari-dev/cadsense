import { CadRenderError } from "@cadsense/contracts";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";
import { CadRenderBroker } from "./CadRenderBroker.ts";
import { routeLayer } from "./http.ts";

const jobId = "00000000-0000-4000-8000-000000000001";
const token = "00000000-0000-4000-8000-000000000002";
const unavailable = () => Effect.fail(new CadRenderError({ reason: "interrupted" }));

describe("CAD binary routes", () => {
  it("validates tickets before reading binary bodies and serves assets without caching", async () => {
    const assetReads: string[] = [];
    const payload = new Uint8Array(64 * 1024).fill(7);
    const broker = CadRenderBroker.of({
      runsForThread: () => Effect.succeed([]),
      endRun: () => Effect.void,
      connect: () => Stream.empty,
      capture: unavailable,
      readJob: unavailable,
      readAsset: (ticket, hash) => {
        if (ticket.token !== token) return unavailable();
        assetReads.push(hash);
        return Effect.succeed(payload);
      },
      complete: () => Effect.die("Expired job must not accept a body"),
      fail: unavailable,
    });
    const app = HttpRouter.toWebHandler(
      routeLayer.pipe(
        Layer.provideMerge(Layer.succeed(CadRenderBroker, broker)),
        Layer.provideMerge(NodeHttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
      { disableLogger: true },
    );
    try {
      const endpoint = `http://localhost/api/cad-render/${jobId}`;
      const missing = await app.handler(new Request(`${endpoint}/${"a".repeat(64)}`));
      expect(missing.status).toBe(400);
      expect(assetReads).toEqual([]);
      const asset = await app.handler(
        new Request(`${endpoint}/${"a".repeat(64)}`, { headers: { "x-cad-render-token": token } }),
      );
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("no-store");
      expect(asset.headers.get("content-type")).toBe("model/gltf-binary");
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(payload);
      const compressed = await app.handler(
        new Request(`${endpoint}/${"a".repeat(64)}`, {
          headers: { "x-cad-render-token": token, "accept-encoding": "gzip" },
        }),
      );
      expect(compressed.headers.get("content-encoding")).toBe("gzip");
      expect(compressed.headers.get("cache-control")).toBe("no-store");
      const packed = await compressed.arrayBuffer();
      expect(packed.byteLength).toBeLessThan(payload.byteLength / 10);
      const decoded = await new Response(
        new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
      expect(new Uint8Array(decoded)).toEqual(payload);
      const expired = await app.handler(
        new Request(endpoint, {
          method: "POST",
          headers: { "x-cad-render-token": token },
          body: "not a png",
        }),
      );
      expect(expired.status).toBe(410);
      const extraPath = await app.handler(
        new Request(`${endpoint}/a/b`, { headers: { "x-cad-render-token": token } }),
      );
      expect(extraPath.status).toBe(400);
    } finally {
      await app.dispose();
    }
  });
});
