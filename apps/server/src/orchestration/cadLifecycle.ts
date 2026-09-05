import {
  initialCadProjectState,
  type CadProjectState,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireProjectCadIdle } from "./commandInvariants.ts";

type CadCommand = Extract<OrchestrationCommand, { type: `project.cad.${string}` }>;

export const decideCadState = Effect.fn("decideCadState")(function* (
  project: OrchestrationProject,
  command: CadCommand,
  readModel: OrchestrationReadModel,
  now: string,
): Effect.fn.Return<CadProjectState, OrchestrationCommandInvariantError> {
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  if (!project.onshapeSource) return yield* fail("This project has no Onshape source.");
  const cad = project.cad ?? initialCadProjectState();
  if (
    command.type === "project.cad.enabled.set" ||
    command.type === "project.cad.operation.reserve"
  ) {
    yield* requireProjectCadIdle({ readModel, command, projectId: project.id, includeRuns: true });
    if (command.type === "project.cad.enabled.set") return { ...cad, enabled: command.enabled };
    if (!cad.enabled) return yield* fail("Onshape is disabled for this project.");
    if ((command.kind === "discover") !== (command.root === null))
      return yield* fail("This CAD operation has an invalid root target.");
    const existing = cad.roots.find((root) => root.rootId === command.root?.rootId);
    if (
      existing &&
      command.root &&
      (existing.elementId !== command.root.elementId ||
        existing.kind !== command.root.kind ||
        existing.configuration !== command.root.configuration)
    ) {
      return yield* fail("The CAD root identity cannot change.");
    }
    if (command.root && !existing && cad.roots.length >= 10_000)
      return yield* fail("This project's CAD root limit has been reached.");
    return {
      ...cad,
      operation: {
        operationId: command.operationId,
        kind: command.kind,
        root: command.root,
        startedAt: now,
      },
    };
  }
  const operation = cad.operation;
  if (!operation || operation.operationId !== command.operationId)
    return yield* fail("This CAD operation is no longer active.");
  const outcome = {
    operationId: operation.operationId,
    kind: operation.kind,
    status:
      command.type === "project.cad.operation.complete" ? ("succeeded" as const) : command.status,
    completedAt: now,
    reason: command.type === "project.cad.operation.complete" ? null : command.reason,
  };
  let roots = cad.roots;
  let catalog = cad.catalog;
  if (command.type === "project.cad.operation.complete") {
    if (command.result.kind !== operation.kind)
      return yield* fail("The CAD result does not match its operation.");
    if (command.result.kind === "discover") catalog = command.result.catalog;
    else if (operation.root) {
      const target = operation.root;
      const existing = roots.find((root) => root.rootId === target.rootId);
      const current = command.result.kind === "sync" ? command.result.snapshot : null;
      const rollback =
        command.result.kind === "sync"
          ? existing?.current?.snapshotId === current?.snapshotId
            ? (existing?.rollback ?? null)
            : (existing?.current ?? null)
          : null;
      const nextRoot = { ...target, current, rollback, lastOutcome: outcome };
      roots = existing
        ? roots.map((root) => (root.rootId === target.rootId ? nextRoot : root))
        : [...roots, nextRoot];
    }
  } else if (operation.root) {
    const target = operation.root;
    const existing = roots.find((root) => root.rootId === target.rootId);
    roots = existing
      ? roots.map((root) =>
          root.rootId === target.rootId ? { ...root, lastOutcome: outcome } : root,
        )
      : [...roots, { ...target, current: null, rollback: null, lastOutcome: outcome }];
  }
  return { ...cad, catalog, roots, operation: null, lastOutcome: outcome };
});
