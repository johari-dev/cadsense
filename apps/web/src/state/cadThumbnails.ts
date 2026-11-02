import { createEnvironmentRpcCommand } from "@cadsense/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../connection/runtime";
import { assetEnvironment } from "./assets";

/** The asset URL query for a snapshot's server-saved thumbnail. */
export const cadThumbnailUrl = (environmentId: EnvironmentId, snapshotId: string) =>
  assetEnvironment.createUrl({
    environmentId,
    input: { resource: { _tag: "cad-thumbnail", snapshotId } },
  });

export const cadThumbnailEnvironment = {
  // A saved thumbnail refreshes its URL query, so every view of the snapshot shows it.
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cad-thumbnail:save",
    tag: WS_METHODS.cadThumbnailSave,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => registry.refresh(cadThumbnailUrl(environmentId, input.snapshotId))),
  }),
};
