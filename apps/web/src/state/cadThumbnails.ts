import { createEnvironmentRpcCommand } from "@cadsense/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../connection/runtime";
import { assetEnvironment } from "./assets";

/**
 * A snapshot's two server-saved preview images: the small opaque thumbnail in the sidebar, and
 * the large transparent backdrop behind the new thread view.
 */
export type CadPreviewKind = "thumbnail" | "backdrop";

/** The asset URL query for one of a snapshot's server-saved preview images. */
export const cadThumbnailUrl = (
  environmentId: EnvironmentId,
  snapshotId: string,
  kind: CadPreviewKind = "thumbnail",
) =>
  assetEnvironment.createUrl({
    environmentId,
    input: {
      resource: { _tag: kind === "backdrop" ? "cad-backdrop" : "cad-thumbnail", snapshotId },
    },
  });

export const cadThumbnailEnvironment = {
  // A saved image refreshes its URL query, so every view of the snapshot shows it.
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cad-thumbnail:save",
    tag: WS_METHODS.cadThumbnailSave,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() =>
        registry.refresh(cadThumbnailUrl(environmentId, input.snapshotId, input.kind)),
      ),
  }),
};
