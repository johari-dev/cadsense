import { NodeServices } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";
import { layerTest } from "./config.ts";
import { browserApiCorsLayer } from "./http.ts";

describe("desktop CAD CORS preflight", () => {
  it("permits panel and background-render capabilities from the desktop origin only", async () => {
    const app = HttpRouter.toWebHandler(
      Layer.mergeAll(
        HttpRouter.add("GET", "/api/cad-panel/test", HttpServerResponse.empty()),
        browserApiCorsLayer,
      ).pipe(
        Layer.provide(
          layerTest(process.cwd(), { prefix: "cadsense-cad-cors-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      { disableLogger: true },
    );
    try {
      for (const { method, headers } of [
        { method: "GET", headers: "x-cad-panel-token" },
        { method: "GET", headers: "x-cad-render-token" },
        { method: "POST", headers: "content-type,x-cad-render-token,x-cad-render-receipt" },
        { method: "DELETE", headers: "x-cad-render-token" },
      ]) {
        const response = await app.handler(
          new Request("http://localhost/api/cad-panel/test", {
            method: "OPTIONS",
            headers: {
              origin: "cadsense://app",
              "access-control-request-method": method,
              "access-control-request-headers": headers,
            },
          }),
        );
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe("cadsense://app");
        const allowed = response.headers.get("access-control-allow-headers")?.split(/\s*,\s*/);
        for (const header of headers.split(",")) expect(allowed).toContain(header);
        expect(response.headers.get("access-control-allow-methods")?.split(/\s*,\s*/)).toContain(
          method,
        );
      }
      const untrusted = await app.handler(
        new Request("http://localhost/api/cad-panel/test", {
          method: "OPTIONS",
          headers: {
            origin: "https://untrusted.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "x-cad-panel-token",
          },
        }),
      );
      expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await app.dispose();
    }
  });
});
