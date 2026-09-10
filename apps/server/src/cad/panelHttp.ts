import { CadPanelSceneTicket } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
  if (hash === "bundle") {
    const seen = new Set<string>();
    const assets = scene.manifest.assets.filter((asset) => {
      if (seen.has(asset.sha256)) return false;
      seen.add(asset.sha256);
      return true;
    });
    const total = assets.reduce((sum, asset) => sum + asset.byteLength, 0);
    const range =
      url.value.searchParams.has("start") || url.value.searchParams.has("end")
        ? `bytes=${url.value.searchParams.get("start")}-${url.value.searchParams.get("end")}`
        : undefined;
    let start = 0,
      end = total - 1;
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return HttpServerResponse.empty({ status: 416, headers });
      start = Number(match[1]);
      end = Number(match[2]);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end >= total ||
        end - start + 1 > 4 * 1024 ** 2
      )
        return HttpServerResponse.empty({ status: 416, headers });
    }
    let offset = 0;
    const slices = assets.flatMap((asset) => {
      const assetStart = offset;
      offset += asset.byteLength;
      return offset > start && assetStart <= end
        ? [
            {
              asset,
              start: Math.max(0, start - assetStart),
              end: Math.min(asset.byteLength, end + 1 - assetStart),
            },
          ]
        : [];
    });
    if (range) {
      // Materialize only this bounded chunk before compression. This gives the
      // browser a complete compressed response with a known content length.
      const bytes = new Uint8Array(end - start + 1);
      let cursor = 0;
      for (const slice of slices) {
        const asset = yield* scene.readAsset(slice.asset.sha256);
        const chunk = asset.subarray(slice.start, slice.end);
        bytes.set(chunk, cursor);
        cursor += chunk.length;
      }
      return HttpServerResponse.uint8Array(bytes, {
        headers: { ...headers, "x-cad-bundle-range": `bytes ${start}-${end}/${total}` },
        contentType: "application/vnd.cadsense.geometry-bundle",
      });
    }
    // Independent bounded ranges tolerate slower connections without retaining a
    // full assembly response. The capability still authorizes every source asset.
    return HttpServerResponse.stream(
      Stream.fromIterable(slices).pipe(
        Stream.mapEffect((slice) =>
          scene
            .readAsset(slice.asset.sha256)
            .pipe(Effect.map((bytes) => bytes.subarray(slice.start, slice.end))),
        ),
      ),
      {
        status: 200,
        headers: {
          ...headers,

          ...(range ? { "x-cad-bundle-range": `bytes ${start}-${end}/${total}` } : {}),
        },
        contentType: "application/vnd.cadsense.geometry-bundle",
      },
    );
  }
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
