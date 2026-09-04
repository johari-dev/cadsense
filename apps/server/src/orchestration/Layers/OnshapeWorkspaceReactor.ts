import { CommandId, type OrchestrationEvent, type ProjectId } from "@cadsense/contracts";
import { makeDrainableWorker } from "@cadsense/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerActivation } from "../../serverActivation.ts";
import { ManagedWorkspaceAllocator } from "../../workspace/ManagedWorkspaceAllocator.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OnshapeWorkspaceProvisionError,
  OnshapeWorkspaceReactor,
  type OnshapeWorkspaceReactorShape,
} from "../Services/OnshapeWorkspaceReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

type OnshapeProjectCreatedEvent = Extract<OrchestrationEvent, { type: "project.created" }>;

interface ProvisionWork {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly commandKey: string;
  readonly sourceSequence?: number;
  readonly deleteOnFailure: boolean;
  readonly completion?: Deferred.Deferred<void, OnshapeWorkspaceProvisionError>;
}

type ProvisionOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed"; readonly error: OnshapeWorkspaceProvisionError };

const MAX_UNCLAIMED_OUTCOMES = 1_000;

const make = Effect.gen(function* () {
  const allocator = yield* ManagedWorkspaceAllocator;
  const orchestration = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const outcomes = yield* Ref.make<ReadonlyMap<number, ProvisionOutcome>>(new Map());
  const seenSequence = yield* SubscriptionRef.make(0);

  const recordOutcome = (sequence: number | undefined, outcome: ProvisionOutcome) => {
    if (sequence === undefined) return Effect.void;
    return Ref.update(outcomes, (current) => {
      const next = new Map(current);
      next.set(sequence, outcome);
      while (next.size > MAX_UNCLAIMED_OUTCOMES) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return next;
    });
  };

  const markReady = (work: ProvisionWork) =>
    orchestration
      .dispatch({
        type: "project.onshape.workspace.ready",
        commandId: CommandId.make(`server:onshape-workspace-ready:${work.commandKey}`),
        projectId: work.projectId,
      })
      .pipe(Effect.retry({ times: 2 }));

  const removeFailedLiveProject = (work: ProvisionWork) =>
    work.deleteOnFailure
      ? orchestration
          .dispatch({
            type: "project.delete",
            commandId: CommandId.make(`server:onshape-workspace-failed:${work.commandKey}`),
            projectId: work.projectId,
          })
          .pipe(
            Effect.retry({ times: 2 }),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("failed to remove an unprovisioned Onshape project", {
                    projectId: work.projectId,
                    cause: Cause.pretty(cause),
                  }),
            ),
          )
      : Effect.void;

  const complete = (work: ProvisionWork, outcome: ProvisionOutcome) =>
    recordOutcome(work.sourceSequence, outcome).pipe(
      Effect.andThen(
        work.completion === undefined
          ? Effect.void
          : outcome._tag === "Ready"
            ? Deferred.succeed(work.completion, undefined)
            : Deferred.fail(work.completion, outcome.error),
      ),
    );

  const fail = <E>(work: ProvisionWork, stage: "provision" | "mark-ready", cause: Cause.Cause<E>) =>
    Effect.gen(function* () {
      if (Cause.hasInterrupts(cause)) {
        return yield* Effect.failCause(cause);
      }
      const error = new OnshapeWorkspaceProvisionError({ projectId: work.projectId });
      if (stage === "provision") {
        yield* removeFailedLiveProject(work);
      }
      yield* complete(work, { _tag: "Failed", error });
      yield* Effect.logWarning(
        stage === "provision"
          ? "failed to provision managed Onshape workspace"
          : "failed to record managed Onshape workspace readiness",
        {
          projectId: work.projectId,
          cause: Cause.pretty(cause),
        },
      );
    });

  const process = Effect.fn("OnshapeWorkspaceReactor.process")(function* (work: ProvisionWork) {
    const provisioned = yield* allocator
      .provision({ projectId: work.projectId, workspaceRoot: work.workspaceRoot })
      .pipe(Effect.exit);
    if (Exit.isFailure(provisioned)) {
      yield* fail(work, "provision", provisioned.cause);
      return;
    }

    const markedReady = yield* markReady(work).pipe(Effect.exit);
    if (Exit.isFailure(markedReady)) {
      yield* fail(work, "mark-ready", markedReady.cause);
      return;
    }

    yield* complete(work, { _tag: "Ready" });
  });

  const worker = yield* makeDrainableWorker(process);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const enqueueCreatedEvent = (event: OnshapeProjectCreatedEvent) =>
    event.payload.onshapeSource === undefined
      ? Effect.void
      : worker.enqueue({
          projectId: event.payload.projectId,
          workspaceRoot: event.payload.workspaceRoot,
          commandKey: event.eventId,
          sourceSequence: event.sequence,
          deleteOnFailure: true,
        });

  const start: OnshapeWorkspaceReactorShape["start"] = Effect.fn("start")(function* () {
    const activation = yield* ServerActivation;
    const subscribed = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const subscription = yield* orchestration.subscribeDomainEvents;
        yield* Deferred.succeed(subscribed, undefined);
        yield* activation ?? Effect.void;
        yield* Stream.runForEach(Stream.fromSubscription(subscription), (event) =>
          (event.type === "project.created" ? enqueueCreatedEvent(event) : Effect.void).pipe(
            Effect.andThen(noteSeen(event.sequence)),
          ),
        );
      }),
    );
    yield* Deferred.await(subscribed);

    const pending = yield* snapshots.listPendingOnshapeProjects().pipe(Effect.orDie);
    const completions = yield* Effect.forEach(pending, (project) =>
      Deferred.make<void, OnshapeWorkspaceProvisionError>().pipe(
        Effect.tap((completion) =>
          worker.enqueue({
            projectId: project.id,
            workspaceRoot: project.workspaceRoot,
            commandKey: `reconcile:${project.id}`,
            deleteOnFailure: false,
            completion,
          }),
        ),
      ),
    );
    yield* worker.drain;
    yield* Effect.forEach(completions, Deferred.await, { discard: true }).pipe(Effect.orDie);
  });

  const drainThrough: OnshapeWorkspaceReactorShape["drainThrough"] = Effect.fn(
    "OnshapeWorkspaceReactor.drainThrough",
  )(function* (target) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
    const outcome = yield* Ref.modify(outcomes, (current) => {
      const found = current.get(target);
      if (found === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(target);
      return [found, next] as const;
    });
    if (outcome === undefined) {
      return yield* Effect.die(`Missing managed Onshape workspace outcome for sequence ${target}.`);
    }
    if (outcome._tag === "Failed") {
      return yield* outcome.error;
    }
  });

  return OnshapeWorkspaceReactor.of({ start, drainThrough });
});

export const OnshapeWorkspaceReactorLive = Layer.effect(OnshapeWorkspaceReactor, make);
