import {
  CadSnapshotManifest,
  CadUserOperationError,
  OnshapeConnectionError,
  CommandId,
  type CadRootIdentity,
  type CadUserStartInput,
  type ProjectId,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OnshapeCadRoots } from "../onshape/OnshapeCadRoots.ts";
import { OnshapeSnapshotAcquisition } from "../onshape/OnshapeSnapshotAcquisition.ts";
import { OnshapeExportError } from "../onshape/OnshapeBulkAcquisition.ts";
import { snapshotRootId } from "../onshape/OnshapeSnapshotManifest.ts";
import { CadSnapshotStore, CadSnapshotStoreError } from "./CadSnapshotStore.ts";
import { pruneCadSnapshots } from "./CadSnapshotRetention.ts";
import { CadGeometryError } from "./CadGeometry.ts";

/** Implementations confirm native process exit while the project's durable reservation is held. */
export class CadProjectQuiescence extends Context.Service<
  CadProjectQuiescence,
  {
    readonly confirm: (projectId: ProjectId) => Effect.Effect<void, CadUserOperationError>;
  }
>()("@cadsense/server/cad/CadUserOperations/CadProjectQuiescence") {}

export class CadUserOperations extends Context.Service<
  CadUserOperations,
  {
    readonly start: (
      input: CadUserStartInput,
    ) => Effect.Effect<{ operationId: string }, CadUserOperationError>;
    readonly cancel: (
      projectId: ProjectId,
      operationId: string,
    ) => Effect.Effect<void, CadUserOperationError>;
    readonly setEnabled: (
      projectId: ProjectId,
      enabled: boolean,
    ) => Effect.Effect<void, CadUserOperationError>;
    readonly recoverInterrupted: Effect.Effect<void, CadUserOperationError>;
  }
>()("@cadsense/server/cad/CadUserOperations") {}

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(CadSnapshotManifest));
const failed = () => new CadUserOperationError({ reason: "operation-failed" });
const isOnshapeConnectionError = Schema.is(OnshapeConnectionError);
const isCadSnapshotStoreError = Schema.is(CadSnapshotStoreError);
const isCadUserOperationError = Schema.is(CadUserOperationError);
const isCadGeometryError = Schema.is(CadGeometryError);
const isOnshapeExportError = Schema.is(OnshapeExportError);
const failureReason = (error: unknown): string => {
  let detail = "CAD operation failed.";
  if (isCadGeometryError(error) && error.reason === "too-large")
    detail = "This CAD exceeds the supported scene size. Choose a smaller assembly or part studio.";
  else if (isOnshapeExportError(error)) {
    switch (error.reason) {
      case "translation-pending":
        detail = "Onshape is still preparing this export. Sync again to resume it.";
        break;
      case "revision-changed":
        detail =
          "The Onshape workspace changed during export. Sync again to download the new revision.";
        break;
      case "translation-failed":
        detail =
          "Onshape could not export this CAD. Check the assembly in Onshape before syncing again.";
        break;
      case "invalid-response":
        detail = "Onshape returned an incomplete export response.";
        break;
    }
  } else if (isCadSnapshotStoreError(error))
    detail =
      error.reason === "disk-space"
        ? "Not enough free disk space. Free space to keep at least 2 GiB available."
        : "Downloaded CAD could not be stored safely.";
  else if (isOnshapeConnectionError(error)) {
    switch (error._tag) {
      case "OnshapeAnnualQuotaExceededError":
        detail = "The Onshape annual API quota is exhausted. No automatic retry will occur.";
        break;
      case "OnshapeRateLimitError":
      case "OnshapeVerificationThrottledError":
        detail = "Onshape is limiting requests. No automatic retry will occur.";
        break;
      case "OnshapeInvalidCredentialsError":
        detail = "Check this connection's credentials in Settings.";
        break;
      case "OnshapeInsufficientPermissionsError":
        detail = "This Onshape connection does not have the required read access.";
        break;
      case "OnshapeConnectionNotFoundError":
        detail = "Choose an available Onshape connection in project settings.";
        break;
      case "OnshapeNetworkError":
        detail = "Could not reach Onshape. Check your network connection.";
        break;
      case "OnshapeResponseError":
        detail = error.message;
        break;
    }
  } else if (isCadUserOperationError(error) && error.reason === "busy")
    detail = "Native agent shutdown could not be confirmed. Stop active runs before trying again.";
  return `${detail} Existing downloaded CAD is unchanged.`;
};

/** Only user RPC handlers receive this service. Accepted jobs outlive route and socket changes. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const store = yield* CadSnapshotStore;
  const roots = yield* OnshapeCadRoots;
  const acquisition = yield* OnshapeSnapshotAcquisition;
  const quiescence = yield* CadProjectQuiescence;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const jobs = new Map<string, { projectId: ProjectId; fiber: Fiber.Fiber<void> }>();
  const prune = (projectId?: ProjectId) =>
    pruneCadSnapshots(projectId).pipe(
      Effect.provideService(CadSnapshotStore, store),
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.catch(() => Effect.logWarning("CAD storage cleanup is pending a local retry.")),
    );
  const commandId = (operationId: string, phase: string) =>
    CommandId.make(`server:cad:${operationId}:${phase}`);
  const getProject = Effect.fn(function* (projectId: ProjectId) {
    const result = yield* query.getProjectShellById(projectId).pipe(Effect.mapError(failed));
    if (Option.isNone(result) || !result.value.onshapeSource)
      return yield* new CadUserOperationError({ reason: "not-found" });
    return { project: result.value, source: result.value.onshapeSource };
  });
  const start = Effect.fn("CadUserOperations.start")(function* (input: CadUserStartInput) {
    const { project, source } = yield* getProject(input.projectId);
    if (
      project.cad?.lastOutcome?.retryAt &&
      Date.parse(project.cad.lastOutcome.retryAt) > DateTime.toEpochMillis(yield* DateTime.now)
    )
      return yield* new CadUserOperationError({ reason: "throttled" });
    let root: CadRootIdentity | null = null;
    if (input.kind === "sync") {
      const selected = input.root;
      const available =
        project.cad?.catalog?.roots.some(
          (entry) => entry.elementId === selected.elementId && entry.kind === selected.kind,
        ) ||
        project.cad?.roots.some(
          (entry) => entry.elementId === selected.elementId && entry.kind === selected.kind,
        );
      if (!available) return yield* new CadUserOperationError({ reason: "invalid-root" });
      const configuration = selected.configuration || "default";
      root = {
        ...selected,
        configuration,
        rootId: snapshotRootId({
          host: source.host,
          documentId: source.documentId,
          originalRevision: { kind: source.workspaceType, id: source.workspaceId },
          elementId: selected.elementId,
          configuration,
        }),
      };
    }
    const operationId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed));
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* engine
          .dispatch({
            type: "project.cad.operation.reserve",
            commandId: commandId(operationId, "reserve"),
            projectId: input.projectId,
            operationId,
            kind: input.kind,
            root,
          })
          .pipe(Effect.mapError(() => new CadUserOperationError({ reason: "busy" })));
        const ready = yield* Deferred.make<void>();
        let completed = false;
        const work = Effect.gen(function* () {
          yield* Deferred.await(ready);
          yield* store.checkReserve();
          yield* quiescence.confirm(input.projectId);
          if (input.kind === "discover") {
            const catalog = yield* roots.discover(source, store.checkReserve());
            yield* engine.dispatch({
              type: "project.cad.operation.complete",
              commandId: commandId(operationId, "complete"),
              projectId: input.projectId,
              operationId,
              result: {
                kind: "discover",
                catalog: { ...catalog, refreshedAt: DateTime.formatIso(yield* DateTime.now) },
              },
            });
          } else {
            const manifest = yield* acquisition.acquire({
              projectId: input.projectId,
              source,
              root: input.root,
            });
            yield* engine.dispatch({
              type: "project.cad.operation.complete",
              commandId: commandId(operationId, "complete"),
              projectId: input.projectId,
              operationId,
              result: {
                kind: "sync",
                snapshot: {
                  snapshotId: manifest.snapshotId,
                  microversionId: manifest.root.microversionId,
                  createdAt: manifest.createdAt,
                  manifestBytes: new TextEncoder().encode(encodeManifest(manifest)).byteLength,
                  assetBytes: [
                    ...new Map(
                      manifest.assets.map((asset) => [asset.sha256, asset.byteLength]),
                    ).values(),
                  ].reduce((total, size) => total + size, 0),
                },
              },
            });
          }
          completed = true;
        }).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              jobs.delete(operationId);
              if (completed) {
                yield* prune(input.projectId);
                return;
              }
              const cancelled = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
              const error = Exit.isFailure(exit)
                ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
                : undefined;
              const retryAfter =
                isOnshapeConnectionError(error) && "retryAfterSeconds" in error
                  ? error.retryAfterSeconds
                  : undefined;
              const retryAt =
                retryAfter === undefined
                  ? undefined
                  : DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: retryAfter }));
              yield* engine
                .dispatch({
                  type: "project.cad.operation.end",
                  commandId: commandId(operationId, "end"),
                  projectId: input.projectId,
                  operationId,
                  status: cancelled ? "cancelled" : "failed",
                  ...(retryAt ? { retryAt } : {}),
                  reason: cancelled ? "CAD operation cancelled." : failureReason(error),
                })
                .pipe(
                  Effect.catch(() =>
                    Effect.logWarning("CAD operation outcome is pending local recovery."),
                  ),
                );
              yield* prune(input.projectId);
            }),
          ),
          Effect.catchCause(() => Effect.void),
        );
        const fiber = yield* Effect.forkIn(restore(work), scope);
        jobs.set(operationId, { projectId: input.projectId, fiber });
        yield* Deferred.succeed(ready, undefined);
        return { operationId };
      }),
    );
  });
  const cancel = Effect.fn("CadUserOperations.cancel")(function* (
    projectId: ProjectId,
    operationId: string,
  ) {
    const job = jobs.get(operationId);
    if (!job || job.projectId !== projectId)
      return yield* new CadUserOperationError({ reason: "unavailable" });
    yield* Fiber.interrupt(job.fiber);
  });
  const setEnabled = Effect.fn("CadUserOperations.setEnabled")(function* (
    projectId: ProjectId,
    enabled: boolean,
  ) {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed));
    yield* engine
      .dispatch({
        type: "project.cad.enabled.set",
        commandId: commandId(id, "enabled"),
        projectId,
        enabled,
      })
      .pipe(Effect.mapError(() => new CadUserOperationError({ reason: "busy" })));
  });
  const recoverInterrupted = Effect.gen(function* () {
    const model = yield* query.getCommandReadModel().pipe(Effect.mapError(failed));
    for (const project of model.projects) {
      const operation = project.cad?.operation;
      if (!operation || jobs.has(operation.operationId)) continue;
      yield* engine
        .dispatch({
          type: "project.cad.operation.end",
          commandId: commandId(operation.operationId, "interrupted"),
          projectId: project.id,
          operationId: operation.operationId,
          status: "interrupted",
          reason: "CAD operation was interrupted. Existing downloaded CAD is unchanged.",
        })
        .pipe(Effect.mapError(failed));
    }
    yield* prune();
  });
  return CadUserOperations.of({ start, cancel, setEnabled, recoverInterrupted });
});
export const layer = Layer.effect(
  CadUserOperations,
  make.pipe(Effect.tap((service) => service.recoverInterrupted)),
);
