import { WS_METHODS } from "@cadsense/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createShellEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    openInFileManager: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shell:open-in-file-manager",
      tag: WS_METHODS.shellOpenInFileManager,
    }),
  };
}
