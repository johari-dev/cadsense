import { createEnvironmentRpcCommand } from "@cadsense/client-runtime/state/runtime";
import { WS_METHODS } from "@cadsense/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const featureScriptEnvironment = {
  /**
   * Runs a `.fs` file locally for the file panel's preview. One run per file is in flight; edits
   * made meanwhile coalesce into one run of the newest text, so typing never queues up runs.
   */
  preview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "featurescript:preview",
    tag: WS_METHODS.featureScriptPreview,
    concurrency: {
      mode: "latest",
      key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd, input.path]),
    },
  }),
};
