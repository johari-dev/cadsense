import { createEnvironmentProjectAtoms } from "@cadsense/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@cadsense/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@cadsense/client-runtime/state/runtime";
import { WS_METHODS } from "@cadsense/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
/** Project content search backing the project-file dialog. */
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
