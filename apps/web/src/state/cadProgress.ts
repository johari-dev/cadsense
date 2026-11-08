import { createEnvironmentRpcSubscriptionAtomFamily } from "@cadsense/client-runtime/state/runtime";
import { WS_METHODS } from "@cadsense/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

/** Live progress of the environment's running Onshape CAD operations. Empty when none runs. */
export const cadProgressEnvironment = {
  watch: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "cad-progress:watch",
    tag: WS_METHODS.cadProgressWatch,
    idleTtlMs: 0,
  }),
};
