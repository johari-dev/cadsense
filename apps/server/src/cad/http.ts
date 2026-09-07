import { CadRenderError, CadRenderTicket } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { CadRenderBroker } from "./CadRenderBroker.ts";
import { compressCadResponse } from "./CadHttpCompression.ts";

const invalid = () => new CadRenderError({ reason: "invalid-result" });
const decodeTicket = Schema.decodeUnknownEffect(CadRenderTicket);
const decodeReceiptJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
/** Tickets are short-lived capabilities issued only on the operate-authorized render stream. */
const handle = Effect.gen(function* () {
  const broker = yield* CadRenderBroker;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return yield* invalid();
  const [jobId, asset, extra] = url.value.pathname.slice("/api/cad-render/".length).split("/");
  if (extra !== undefined) return yield* invalid();
  const ticket = yield* decodeTicket({
    jobId,
    token: request.headers["x-cad-render-token"],
  }).pipe(Effect.mapError(invalid));
  if (request.method === "GET") {
    if (asset !== undefined) {
      const bytes = yield* broker.readAsset(ticket, asset);
      return HttpServerResponse.uint8Array(bytes, { headers, contentType: "model/gltf-binary" });
    }
    return yield* HttpServerResponse.json(yield* broker.readJob(ticket), { headers }).pipe(
      Effect.mapError(invalid),
    );
  }
  if (asset !== undefined) return yield* invalid();
  if (request.method === "DELETE") {
    yield* broker.fail(ticket);
    return HttpServerResponse.empty({ status: 204, headers });
  }
  // Reject expired tickets before consuming a potentially large body.
  yield* broker.readJob(ticket);
  const receipt = yield* decodeReceiptJson(request.headers["x-cad-render-receipt"]).pipe(
    Effect.mapError(invalid),
  );
  const bytes = yield* request.arrayBuffer.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(16 * 1024 ** 2)),
    Effect.mapError(invalid),
  );
  yield* broker.complete(ticket, receipt, new Uint8Array(bytes));
  return HttpServerResponse.empty({ status: 204, headers });
}).pipe(
  Effect.catchTag("CadRenderError", (error) =>
    Effect.succeed(
      HttpServerResponse.text(error.reason, {
        status: error.reason === "invalid-result" ? 400 : error.reason === "busy" ? 429 : 410,
        headers,
      }),
    ),
  ),
  compressCadResponse,
);

export const routeLayer = Layer.mergeAll(
  HttpRouter.add("GET", "/api/cad-render/*", handle),
  HttpRouter.add("POST", "/api/cad-render/*", handle),
  HttpRouter.add("DELETE", "/api/cad-render/*", handle),
);
