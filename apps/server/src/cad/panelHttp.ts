import { CadPanelSceneTicket } from "@cadsense/contracts";
import { CAD_TRANSFER_VERSION } from "@cadsense/shared/cadTransfer";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { CadPanel } from "./CadPanel.ts";
import { ServerConfig } from "../config.ts";
import { cadTransferArtifacts, cadTransferIdentity } from "./CadTransferArtifacts.ts";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";
import { compressCadResponse } from "./CadHttpCompression.ts";
import {
  acceptsPreparedCadEncoding,
  CAD_BUNDLE_RANGE_BYTES,
  createCadBundlePlan,
  createCadBundleRange,
  preparedCadTransfers,
} from "./CadPreparedTransfer.ts";

const decodeTicket = Schema.decodeUnknownEffect(CadPanelSceneTicket);
class CadTransferHttpError extends Schema.TaggedErrorClass<CadTransferHttpError>()(
  "CadTransferHttpError",
  { status: Schema.Number },
) {}
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
  if (hash === "transfer-index" || hash === "transfer") {
    const config = yield* Effect.serviceOption(ServerConfig);
    if (Option.isNone(config)) return HttpServerResponse.empty({ status: 503, headers });
    const artifacts = cadTransferArtifacts(config.value.stateDir);
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    artifacts.retain(scene.manifest.assets, scene, () =>
      runPromise(Deferred.await(scene.released)),
    );
    if (hash === "transfer-index") {
      const store = yield* Effect.serviceOption(CadSnapshotStore);
      if (Option.isNone(store)) return HttpServerResponse.empty({ status: 503, headers });
      return yield* Effect.tryPromise(() =>
        artifacts.get(scene.manifest.assets, (sha256) => runPromise(scene.readAsset(sha256)), {
          withSource: (use) =>
            runPromise(
              store.value
                .withPinned(scene.manifest.snapshotId, (manifest, readAsset) =>
                  Effect.tryPromise(() => {
                    if (
                      cadTransferIdentity(manifest.assets) !==
                      cadTransferIdentity(scene.manifest.assets)
                    )
                      throw new Error("CAD transfer source changed");
                    return use((sha256) => runPromise(readAsset(sha256)));
                  }),
                )
                .pipe(Effect.uninterruptible),
            ),
        }),
      ).pipe(
        Effect.flatMap((artifact) => HttpServerResponse.json(artifact, { headers })),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503, headers })),
      );
    }
    const identity = url.value.searchParams.get("identity") ?? "";
    const startValue = url.value.searchParams.get("start") ?? "";
    const endValue = url.value.searchParams.get("end") ?? "";
    if (!/^\d+$/.test(startValue) || !/^\d+$/.test(endValue))
      return HttpServerResponse.empty({ status: 416, headers });
    const start = Number(startValue);
    const end = Number(endValue);
    const brotli = acceptsPreparedCadEncoding(request.headers["accept-encoding"]);
    return yield* Effect.tryPromise({
      try: () => artifacts.range(scene.manifest.assets, identity, start, end, brotli),
      catch: (error) =>
        new CadTransferHttpError({ status: error instanceof RangeError ? 416 : 404 }),
    }).pipe(
      Effect.map(({ bytes, byteLength }) =>
        HttpServerResponse.uint8Array(bytes, {
          headers: {
            ...headers,
            ...(brotli
              ? { "content-encoding": "br", "content-length": String(bytes.byteLength) }
              : {}),
            vary: "Accept-Encoding",
            "x-cad-bundle-range": `bytes ${start}-${end}/${byteLength}`,
          },
          contentType: "application/vnd.cadsense.geometry-bundle",
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(HttpServerResponse.empty({ status: error.status, headers })),
      ),
    );
  }
  if (hash === "bundle") {
    const bundle = createCadBundlePlan(scene.manifest);
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const readAsset = (sha256: string) => runPromise(scene.readAsset(sha256));
    const range =
      url.value.searchParams.has("start") || url.value.searchParams.has("end")
        ? `bytes=${url.value.searchParams.get("start")}-${url.value.searchParams.get("end")}`
        : undefined;
    let start = 0,
      end = bundle.totalBytes - 1;
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return HttpServerResponse.empty({ status: 416, headers });
      start = Number(match[1]);
      end = Number(match[2]);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end >= bundle.totalBytes ||
        end - start + 1 > CAD_BUNDLE_RANGE_BYTES
      )
        return HttpServerResponse.empty({ status: 416, headers });
    }
    const selected = range
      ? createCadBundleRange(bundle, start, end)
      : {
          start,
          end,
          slices: bundle.assets.map((asset) => ({
            sha256: asset.sha256,
            byteLength: asset.byteLength,
            start: 0,
            end: asset.byteLength,
          })),
        };
    if (range) {
      if (acceptsPreparedCadEncoding(request.headers["accept-encoding"])) {
        const encoded = yield* Effect.tryPromise(() =>
          preparedCadTransfers.get(bundle, selected, readAsset),
        );
        return HttpServerResponse.uint8Array(encoded, {
          headers: {
            ...headers,
            "content-encoding": "br",
            "content-length": String(encoded.byteLength),
            vary: "Accept-Encoding",
            "x-cad-bundle-range": `bytes ${start}-${end}/${bundle.totalBytes}`,
          },
          contentType: "application/vnd.cadsense.geometry-bundle",
        });
      }
      const bytes = new Uint8Array(end - start + 1);
      let cursor = 0;
      for (const slice of selected.slices) {
        const asset = yield* scene.readAsset(slice.sha256);
        const chunk = asset.subarray(slice.start, slice.end);
        bytes.set(chunk, cursor);
        cursor += chunk.length;
      }
      return HttpServerResponse.uint8Array(bytes, {
        headers: {
          ...headers,
          "x-cad-bundle-range": `bytes ${start}-${end}/${bundle.totalBytes}`,
        },
        contentType: "application/vnd.cadsense.geometry-bundle",
      });
    }
    // Independent bounded ranges tolerate slower connections without retaining a
    // full assembly response. The capability still authorizes every source asset.
    return HttpServerResponse.stream(
      Stream.fromIterable(selected.slices).pipe(
        Stream.mapEffect((slice) =>
          scene
            .readAsset(slice.sha256)
            .pipe(Effect.map((bytes) => bytes.subarray(slice.start, slice.end))),
        ),
      ),
      {
        status: 200,
        headers: {
          ...headers,

          ...(range ? { "x-cad-bundle-range": `bytes ${start}-${end}/${bundle.totalBytes}` } : {}),
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
  if (
    url.value.searchParams.get("delivery") !== CAD_TRANSFER_VERSION &&
    acceptsPreparedCadEncoding(request.headers["accept-encoding"])
  ) {
    const bundle = createCadBundlePlan(scene.manifest);
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    void preparedCadTransfers.warm(bundle, (sha256) => runPromise(scene.readAsset(sha256)));
  }
  return yield* HttpServerResponse.json(scene.manifest, { headers });
}).pipe(
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 410, headers })),
  compressCadResponse,
);
export const routeLayer = HttpRouter.add("GET", "/api/cad-panel/*", handle);
