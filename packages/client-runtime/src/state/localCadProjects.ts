import { WS_METHODS } from "@cadsense/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/** Commands for adding a folder project that reviews a local STEP or IGES file. */
export function createLocalCadProjectAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    listFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:local-cad:list-files",
      tag: WS_METHODS.localCadFilesList,
      scheduler,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:local-cad:create",
      tag: WS_METHODS.localCadProjectsCreate,
      scheduler,
    }),
  };
}
