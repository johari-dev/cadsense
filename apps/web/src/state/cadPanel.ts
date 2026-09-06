import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@cadsense/client-runtime/state/runtime";
import { WS_METHODS } from "@cadsense/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const cadPanelEnvironment = {
  watch: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "cad-panel:watch",
    tag: WS_METHODS.cadPanelWatch,
    idleTtlMs: 0,
  }),
  scene: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "cad-panel:scene",
    tag: WS_METHODS.cadPanelScene,
    idleTtlMs: 0,
  }),
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cad-panel:save",
    tag: WS_METHODS.cadPanelSave,
  }),
};
