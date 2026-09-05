import { type EnvironmentId, WS_METHODS } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/**
 * Environment connection changes share one lane because their public metadata
 * and secret files are committed as one environment-owned catalog.
 */
const onshapeConnectionMutationConcurrencyKey = (input: {
  readonly environmentId: string;
}): string => input.environmentId;

export function createOnshapeConnectionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const mutationScheduler = createAtomCommandScheduler();
  const mutationConcurrency = {
    mode: "serial" as const,
    key: onshapeConnectionMutationConcurrencyKey,
  };
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:onshape-connections:list",
    tag: WS_METHODS.onshapeConnectionsList,
    staleTimeMs: 30_000,
  });
  const refreshList = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId: target.environmentId, input: {} }));
    });

  return {
    list,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:onshape-connections:create",
      tag: WS_METHODS.onshapeConnectionsCreate,
      scheduler: mutationScheduler,
      concurrency: mutationConcurrency,
      onSuccess: refreshList,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:onshape-connections:rename",
      tag: WS_METHODS.onshapeConnectionsRename,
      scheduler: mutationScheduler,
      concurrency: mutationConcurrency,
      onSuccess: refreshList,
    }),
    replaceCredentials: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:onshape-connections:replace-credentials",
      tag: WS_METHODS.onshapeConnectionsReplaceCredentials,
      scheduler: mutationScheduler,
      concurrency: mutationConcurrency,
      onSuccess: refreshList,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:onshape-connections:remove",
      tag: WS_METHODS.onshapeConnectionsRemove,
      scheduler: mutationScheduler,
      concurrency: mutationConcurrency,
      onSuccess: refreshList,
    }),
  };
}
