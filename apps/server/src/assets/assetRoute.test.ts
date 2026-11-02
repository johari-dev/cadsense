import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { assetRouteLayer } from "../http.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { issueAssetUrl } from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "cadsense-asset-route-test-",
});
const servicesLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * The file panel downloads a model after every preview, through the asset route. Failure modes:
 * models sent uncompressed (megabytes per edit over a remote link); a client that didn't ask for
 * gzip getting it anyway; already-compressed files (PNGs) compressed again; the decoded body
 * differing from the file.
 */
describe("asset route", () => {
  it.effect("gzips models for clients that accept it, and nothing else", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      // Repetitive like mesh data, and well over the compression threshold.
      const model = new Uint8Array(256 * 1024).map((_, i) => (i * 7) % 13);
      const modelId = "fspanel-1-00000000-0000-4000-8000-000000000001";
      yield* fileSystem.writeFile(path.join(config.attachmentsDir, `${modelId}.bin`), model);
      const imageId = "thread-1-00000000-0000-4000-8000-000000000002";
      yield* fileSystem.writeFile(path.join(config.attachmentsDir, `${imageId}.png`), model);
      const modelUrl = (yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId: modelId,
          fileName: "preview.glb",
          mimeType: "model/gltf-binary",
        },
      })).relativeUrl;
      const imageUrl = (yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId: imageId },
      })).relativeUrl;

      const services = yield* Effect.context<
        ServerConfig.ServerConfig | ServerSecretStore.ServerSecretStore
      >();
      const app = HttpRouter.toWebHandler(
        assetRouteLayer.pipe(
          Layer.provideMerge(Layer.succeedContext(services)),
          Layer.provideMerge(NodeHttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))),
          Layer.provideMerge(servicesLayer),
        ),
        { disableLogger: true },
      );
      const get = (url: string, encoding?: string) =>
        Effect.promise(() =>
          app.handler(
            new Request(`http://localhost${url}`, {
              headers: encoding ? { "accept-encoding": encoding } : {},
            }),
          ),
        );
      const bytes = (response: Response) =>
        Effect.promise(async () => new Uint8Array(await response.arrayBuffer()));
      try {
        const gzipped = yield* get(modelUrl, "gzip, deflate, br");
        expect(gzipped.status).toBe(200);
        expect(gzipped.headers.get("content-encoding")).toBe("gzip");
        const packed = yield* bytes(gzipped);
        expect(packed.byteLength).toBeLessThan(model.byteLength / 10);
        const decoded = yield* Effect.promise(
          async () =>
            new Uint8Array(
              await new Response(
                new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip")),
              ).arrayBuffer(),
            ),
        );
        expect(decoded).toEqual(model);

        const plain = yield* get(modelUrl);
        expect(plain.headers.get("content-encoding")).toBeNull();
        expect(yield* bytes(plain)).toEqual(model);

        const image = yield* get(imageUrl, "gzip");
        expect(image.headers.get("content-encoding")).toBeNull();
        expect(yield* bytes(image)).toEqual(model);
      } finally {
        yield* Effect.promise(() => app.dispose());
      }
    }).pipe(Effect.provide(servicesLayer)),
  );
});
