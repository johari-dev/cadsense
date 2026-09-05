import { CadRenderError } from "@cadsense/contracts";
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
    const broker = CadRenderBroker.of({
      connect: () => Stream.empty,
      capture: unavailable,
      readJob: unavailable,
      readAsset: (ticket, hash) => {
        if (ticket.token !== token) return unavailable();
        assetReads.push(hash);
        return Effect.succeed(new Uint8Array([1, 2, 3]));
      },
      complete: () => Effect.die("Expired job must not accept a body"),
      fail: unavailable,
    });
    const app = HttpRouter.toWebHandler(
      routeLayer.pipe(Layer.provideMerge(Layer.succeed(CadRenderBroker, broker))),
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
      expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([1, 2, 3]);
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
