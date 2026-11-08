import type {
  CadOperationProgress as CadOperationProgressEntry,
  CadSyncStep,
  ProjectId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * What Onshape code reports while a CAD operation runs. `step` names the current sync step, with
 * the units it has finished when it counts them; `apiCall` records one call Onshape bills.
 * Outside a tracked operation both do nothing, so the same code serves scripts and tests.
 */
export interface CadProgressReporterShape {
  readonly step: (
    step: CadSyncStep,
    progress?: { readonly done: number; readonly total?: number },
  ) => Effect.Effect<void>;
  readonly apiCall: Effect.Effect<void>;
}
export const CadProgressReporter = Context.Reference<CadProgressReporterShape>(
  "@cadsense/server/cad/CadProgressReporter",
  { defaultValue: () => ({ step: () => Effect.void, apiCall: Effect.void }) },
);

/** One tracked operation: provide `reporter` to its work, read `apiCalls`, then `end` it. */
export interface CadProgressTracking {
  readonly reporter: CadProgressReporterShape;
  readonly apiCalls: Effect.Effect<number>;
  readonly end: Effect.Effect<void>;
}

/**
 * Live progress of running Onshape CAD operations, in server memory only. The CAD panel's sync
 * toast watches it; the outcome the operation records is what lasts.
 */
export class CadOperationProgress extends Context.Service<
  CadOperationProgress,
  {
    readonly begin: (
      operationId: string,
      projectId: ProjectId,
    ) => Effect.Effect<CadProgressTracking>;
    readonly watch: Stream.Stream<ReadonlyArray<CadOperationProgressEntry>>;
  }
>()("@cadsense/server/cad/CadOperationProgress") {}

export const make = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<ReadonlyMap<string, CadOperationProgressEntry>>(
    new Map(),
  );
  const begin = Effect.fn("CadOperationProgress.begin")(function* (
    operationId: string,
    projectId: ProjectId,
  ) {
    let apiCalls = 0;
    // Updates only a tracked entry, so a report after `end` cannot bring it back.
    const update = (next: (entry: CadOperationProgressEntry) => CadOperationProgressEntry) =>
      SubscriptionRef.update(state, (current) => {
        const entry = current.get(operationId);
        return entry ? new Map(current).set(operationId, next(entry)) : current;
      });
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(state, (current) =>
      new Map(current).set(operationId, {
        operationId,
        projectId,
        step: "checking",
        stepStartedAt: startedAt,
        apiCalls: 0,
      }),
    );
    const reporter: CadProgressReporterShape = {
      step: (step, progress) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            update(({ done: _done, total: _total, ...entry }) => ({
              ...entry,
              step,
              // Elapsed time counts from when the step began, not from its latest report.
              stepStartedAt: entry.step === step ? entry.stepStartedAt : DateTime.formatIso(now),
              ...(progress ? { done: progress.done } : {}),
              ...(progress?.total === undefined ? {} : { total: progress.total }),
            })),
          ),
        ),
      apiCall: Effect.suspend(() => {
        apiCalls++;
        return update((entry) => ({ ...entry, apiCalls }));
      }),
    };
    return {
      reporter,
      apiCalls: Effect.sync(() => apiCalls),
      end: SubscriptionRef.update(state, (current) => {
        if (!current.has(operationId)) return current;
        const next = new Map(current);
        next.delete(operationId);
        return next;
      }),
    };
  });
  const watch = SubscriptionRef.changes(state).pipe(Stream.map((current) => [...current.values()]));
  return CadOperationProgress.of({ begin, watch });
});

export const layer = Layer.effect(CadOperationProgress, make);
