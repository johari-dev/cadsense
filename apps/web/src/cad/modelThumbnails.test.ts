import { AssetCadThumbnailNotFoundError } from "@cadsense/contracts";
import { EnvironmentRpcUnavailableError } from "@cadsense/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { isModelThumbnailMissing } from "./modelThumbnails";

const snapshotId = "00000000-0000-4000-8000-000000000001";

describe("isModelThumbnailMissing", () => {
  it("is true only when the server says the snapshot has no thumbnail", () => {
    expect(
      isModelThumbnailMissing(
        AsyncResult.failure(
          Cause.fail(
            new AssetCadThumbnailNotFoundError({ resource: { _tag: "cad-thumbnail", snapshotId } }),
          ),
        ),
      ),
    ).toBe(true);
  });

  it("never asks for a capture while the answer is unknown or the thumbnail exists", () => {
    expect(isModelThumbnailMissing(AsyncResult.initial())).toBe(false);
    expect(isModelThumbnailMissing(AsyncResult.initial(true))).toBe(false);
    expect(
      isModelThumbnailMissing(
        AsyncResult.success({ relativeUrl: "/api/assets/t/x", expiresAt: 1 }),
      ),
    ).toBe(false);
    // Offline or unauthorized is not "missing": capturing would only fail to upload.
    expect(
      isModelThumbnailMissing(
        AsyncResult.failure(
          Cause.fail(
            new EnvironmentRpcUnavailableError({ environmentId: "local", message: "offline" }),
          ),
        ),
      ),
    ).toBe(false);
  });
});
