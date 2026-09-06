import { CAD_TOOL_INPUTS, CadViewError, type ThreadId, type TurnId } from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { CadViewing, type CadAgentTools } from "../cad/CadViewing.ts";

const descriptions = {
  cad_context: "Read your private CAD view revision, state, and locally available scene roots.",
  cad_hierarchy:
    "Read a bounded page of the selected CAD component tree with occurrence visibility.",
  cad_update_view:
    "Atomically update your private CAD view at expectedRevision. Changes remain private until captured.",
  cad_capture:
    "Capture exactly expectedRevision as a PNG image and managed artifact. The captured view is eligible for display to the user.",
} satisfies Record<keyof typeof CAD_TOOL_INPUTS, string>;

export const cadToolDefinitions = Object.entries(CAD_TOOL_INPUTS).map(([name, schema]) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    type: "function" as const,
    name,
    description: descriptions[name as keyof typeof descriptions],
    inputSchema: { ...document.schema, $defs: document.definitions },
  };
});
export interface CadToolDelivery {
  readonly result: unknown;
  readonly png?: Uint8Array;
}
export const invokeCadTool = Effect.fn("invokeCadTool")(function* (
  tools: CadAgentTools,
  name: string,
  input: unknown,
): Effect.fn.Return<CadToolDelivery, CadViewError> {
  switch (name) {
    case "cad_context":
      return { result: yield* tools.context() };
    case "cad_hierarchy":
      return { result: yield* tools.hierarchy(input) };
    case "cad_update_view":
      return { result: yield* tools.updateView(input) };
    case "cad_capture":
      return yield* tools.capture(input);
    default:
      return yield* new CadViewError({ reason: "capability-unavailable" });
  }
});

/** One native session owns these activations. Only trusted adapter callbacks supply child keys and turn IDs. */
export const makeCadProviderTools = Effect.fn("makeCadProviderTools")(function* (
  threadId: ThreadId,
) {
  const viewing = yield* CadViewing;
  const owner = yield* Scope.Scope;
  const gate = yield* Semaphore.make(1);
  const entries = new Map<
    string | null,
    { turnId: TurnId; scope: Scope.Closeable; tools: CadAgentTools }
  >();
  const ended = new Map<string | null, Set<TurnId>>();
  let open = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      open = false;
    }),
  );
  const get = Effect.fn("CadProviderTools.get")(function* (
    childKey: string | null,
    turnId: TurnId,
  ) {
    if (!open || ended.get(childKey)?.has(turnId))
      return yield* new CadViewError({ reason: "capability-unavailable" });
    const prior = entries.get(childKey);
    if (prior?.turnId === turnId) return prior;
    if (prior) {
      entries.delete(childKey);
      yield* Scope.close(prior.scope, Exit.void);
    }
    const contextId = yield* viewing.resolveContext(threadId, childKey ?? undefined);
    const scope = yield* Scope.fork(owner);
    const ready = yield* Deferred.make<CadAgentTools, CadViewError>();
    yield* viewing
      .withActivation(
        contextId,
        (tools) => Deferred.succeed(ready, tools).pipe(Effect.andThen(Effect.never)),
        turnId,
      )
      .pipe(
        Effect.catch((error) => Deferred.fail(ready, error)),
        Effect.forkIn(scope),
      );
    const tools = yield* Deferred.await(ready).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)),
    );
    const entry = { turnId, scope, tools };
    entries.set(childKey, entry);
    return entry;
  });
  const invoke = Effect.fn("CadProviderTools.invoke")(function* (
    childKey: string | null,
    turnId: TurnId,
    name: string,
    input: unknown,
  ) {
    const entry = yield* gate.withPermits(1)(get(childKey, turnId));
    if (!open) return yield* new CadViewError({ reason: "capability-unavailable" });
    const result = yield* Deferred.make<CadToolDelivery, CadViewError>();
    const call = yield* invokeCadTool(entry.tools, name, input).pipe(
      Effect.onExit((exit) => Deferred.done(result, exit)),
      Effect.forkIn(entry.scope),
    );
    return yield* Deferred.await(result).pipe(Effect.ensuring(Fiber.interrupt(call)));
  });
  const end = (childKey: string | null, turnId: TurnId) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const turns = ended.get(childKey) ?? new Set<TurnId>();
        turns.add(turnId);
        ended.set(childKey, turns);
        const entry = entries.get(childKey);
        if (entry?.turnId !== turnId) return;
        entries.delete(childKey);
        yield* Scope.close(entry.scope, Exit.void);
      }),
    );
  const close = gate.withPermits(1)(
    Effect.gen(function* () {
      open = false;
      for (const entry of entries.values()) yield* Scope.close(entry.scope, Exit.void);
      entries.clear();
      ended.clear();
    }),
  );
  return { invoke, end, close };
});
export type CadProviderTools = Effect.Success<ReturnType<typeof makeCadProviderTools>>;
