import { CadPanelSceneTicket } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { CadPanel } from "./CadPanel.ts";
import { compressCadResponse } from "./CadHttpCompression.ts";

const decodeTicket = Schema.decodeUnknownEffect(CadPanelSceneTicket);
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const handle = Effect.gen(function* () {
  const panel = yield* CadPanel;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400, headers });
  const [sceneId, hash, extra] = url.value.pathname.slice("/api/cad-panel/".length).split("/");
  if (extra !== undefined) return HttpServerResponse.empty({ status: 400, headers });
  const ticket = yield* decodeTicket({ sceneId, token: request.headers["x-cad-panel-token"] });
  const scene = yield* panel.read(ticket);
  if (hash !== undefined)
    return HttpServerResponse.uint8Array(yield* scene.readAsset(hash), {
      headers,
      contentType: "model/gltf-binary",
    });
  return yield* HttpServerResponse.json(scene.manifest, { headers });
}).pipe(
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 410, headers })),
  compressCadResponse,
);
export const routeLayer = HttpRouter.add("GET", "/api/cad-panel/*", handle);
