import { HttpMiddleware } from "effect/unstable/http";

// GLB contains raw geometry buffers; the generic HTTP middleware treats model/*
// as already compressed. Use inexpensive negotiated gzip for these local assets.
export const compressCadResponse = HttpMiddleware.compression({
  algorithms: ["gzip"],
  levels: { gzip: 1 },
  compressible: (contentType) =>
    ["model/gltf-binary", "application/vnd.cadsense.geometry-bundle"].includes(
      contentType.split(";")[0]?.trim() ?? "",
    ),
});
