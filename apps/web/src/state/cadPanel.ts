import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@cadsense/client-runtime/state/runtime";
import { WS_METHODS } from "@cadsense/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const cadPanelEnvironment = {
  comments: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "cad-comments:watch",
    tag: WS_METHODS.cadCommentsWatch,
    idleTtlMs: 60000,
  }),
  review: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cad-comments:review",
    tag: WS_METHODS.cadCommentReview,
  }),
  watch: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "cad-panel:watch",
    tag: WS_METHODS.cadPanelWatch,
    idleTtlMs: 60_000,
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
