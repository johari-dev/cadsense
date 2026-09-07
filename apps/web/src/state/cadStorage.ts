import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@cadsense/client-runtime/state/runtime";
import { WS_METHODS } from "@cadsense/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
export const cadStorageEnvironment = {
  watch: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "cad-storage:watch",
    tag: WS_METHODS.cadStorageWatch,
    idleTtlMs: 0,
  }),
  run: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cad-storage:run",
    tag: WS_METHODS.cadStorageRun,
  }),
};
