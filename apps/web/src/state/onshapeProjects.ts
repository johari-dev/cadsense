import { createOnshapeProjectAtoms } from "@cadsense/client-runtime/state/onshapeProjects";

import { connectionAtomRuntime } from "../connection/runtime";

export const onshapeProjectEnvironment = createOnshapeProjectAtoms(connectionAtomRuntime);
