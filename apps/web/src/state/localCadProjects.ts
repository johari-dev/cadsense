import { createLocalCadProjectAtoms } from "@cadsense/client-runtime/state/localCadProjects";

import { connectionAtomRuntime } from "../connection/runtime";

export const localCadProjectEnvironment = createLocalCadProjectAtoms(connectionAtomRuntime);
