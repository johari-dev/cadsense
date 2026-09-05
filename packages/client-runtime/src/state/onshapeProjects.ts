import { WS_METHODS } from "@cadsense/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

export function createOnshapeProjectAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:onshape-projects:create",
      tag: WS_METHODS.onshapeProjectsCreate,
      scheduler,
      concurrency,
    }),
    setConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:onshape-projects:set-connection",
      tag: WS_METHODS.onshapeProjectsSetConnection,
      scheduler,
      concurrency,
    }),
  };
}
