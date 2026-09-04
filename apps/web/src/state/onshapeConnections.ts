import { createOnshapeConnectionAtoms } from "@cadsense/client-runtime/state/onshapeConnections";

import { connectionAtomRuntime } from "../connection/runtime";

export const onshapeConnectionEnvironment = createOnshapeConnectionAtoms(connectionAtomRuntime);
