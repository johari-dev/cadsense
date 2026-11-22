import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import type { OrchestrationProjectShell, OrchestrationThread } from "./orchestration.ts";
import { CadCaptureId, CadHash, CadRootKind, CadSnapshotId, CadUuid } from "./cad.ts";
import { OnshapeApiUsage, OnshapeElementId, OnshapeWorkspaceId } from "./onshape.ts";

export const CadOperationId = CadUuid.pipe(Schema.brand("CadOperationId"));
export type CadOperationId = typeof CadOperationId.Type;
export const CadOperationKind = Schema.Literals(["discover", "sync", "cleanup"]);
export const CadRootIdentity = Schema.Struct({
  rootId: CadHash,
  elementId: OnshapeElementId,
  kind: CadRootKind,
  configuration: Schema.String.check(Schema.isMaxLength(4096)),
});
export type CadRootIdentity = typeof CadRootIdentity.Type;
export const CadCatalog = Schema.Struct({
  refreshedAt: IsoDateTime,
  microversionId: OnshapeWorkspaceId,
  roots: Schema.Array(
    Schema.Struct({
      elementId: OnshapeElementId,
      name: Schema.String.check(Schema.isMaxLength(4096)),
      kind: CadRootKind,
    }),
  ).check(Schema.isMaxLength(10_000)),
  sourceElement: Schema.NullOr(
    Schema.Struct({
      elementId: OnshapeElementId,
      status: Schema.Literals(["available", "missing", "unsupported"]),
    }),
  ),
});
export type CadCatalog = typeof CadCatalog.Type;
export const CadSnapshotMetadata = Schema.Struct({
  snapshotId: CadSnapshotId,
  microversionId: OnshapeWorkspaceId,
  createdAt: IsoDateTime,
  manifestBytes: NonNegativeInt,
  assetBytes: NonNegativeInt,
});
export type CadSnapshotMetadata = typeof CadSnapshotMetadata.Type;
/** The Onshape API calls one CAD operation made, and its connection's yearly usage after it. */
export const CadOperationApiCalls = Schema.Struct({
  calls: NonNegativeInt,
  usage: OnshapeApiUsage,
});
export type CadOperationApiCalls = typeof CadOperationApiCalls.Type;
export const CadOperationOutcome = Schema.Struct({
  operationId: CadOperationId,
  kind: CadOperationKind,
  status: Schema.Literals(["succeeded", "failed", "cancelled", "interrupted"]),
  completedAt: IsoDateTime,
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  retryAt: Schema.optionalKey(IsoDateTime),
  // Onshape operations only. Absent on local CAD and on outcomes recorded before it existed.
  apiCalls: Schema.optionalKey(CadOperationApiCalls),
});
export const CadRootLineage = Schema.Struct({
  ...CadRootIdentity.fields,
  current: Schema.NullOr(CadSnapshotMetadata),
  rollback: Schema.NullOr(CadSnapshotMetadata),
  lastOutcome: Schema.NullOr(CadOperationOutcome),
});
/**
 * The steps of an Onshape sync, in order. A sync of a microversion skips `checking` and
 * `exporting`, as it downloads each part itself; an unchanged sync can end after `checking`.
 */
export const CAD_SYNC_STEPS = [
  "checking",
  "reading",
  "exporting",
  "downloading",
  "building",
  "saving",
] as const;
export const CadSyncStep = Schema.Literals(CAD_SYNC_STEPS);
export type CadSyncStep = typeof CadSyncStep.Type;
/**
 * Live progress of one running Onshape CAD operation. Held in server memory only and never
 * persisted: it ends with the operation, whose outcome records what lasts.
 */
export const CadOperationProgress = Schema.Struct({
  operationId: CadOperationId,
  projectId: ProjectId,
  step: CadSyncStep,
  stepStartedAt: IsoDateTime,
  // Units the step has finished, and how many it has when known: parts, or bytes downloaded.
  done: Schema.optionalKey(NonNegativeInt),
  total: Schema.optionalKey(NonNegativeInt),
  apiCalls: NonNegativeInt,
});
export type CadOperationProgress = typeof CadOperationProgress.Type;
export const CadOperation = Schema.Struct({
  operationId: CadOperationId,
  kind: CadOperationKind,
  root: Schema.NullOr(CadRootIdentity),
  startedAt: IsoDateTime,
});
export const CadProjectState = Schema.Struct({
  storage: Schema.optionalKey(
    Schema.Struct({
      removedAt: IsoDateTime,
      deleteCad: Schema.Boolean,
      deleteWorkspace: Schema.Boolean,
      cleanupPending: Schema.Boolean,
    }),
  ),
  pendingPresentations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        turnId: TurnId,
        captureId: CadCaptureId,
        rootId: CadHash,
      }),
    ).check(Schema.isMaxLength(10_000)),
  ),
  enabled: Schema.Boolean,
  catalog: Schema.NullOr(CadCatalog),
  roots: Schema.Array(CadRootLineage).check(Schema.isMaxLength(10_000)),
  operation: Schema.NullOr(CadOperation),
  lastOutcome: Schema.NullOr(CadOperationOutcome),
});
export type CadProjectState = typeof CadProjectState.Type;
export const isCadThreadRunActive = (
  thread: Pick<OrchestrationThread, "turnAdmission" | "session" | "latestTurn"> & {
    readonly backgroundLiveness?: OrchestrationThread["backgroundLiveness"] | undefined;
  },
): boolean =>
  (thread.turnAdmission?.pending.length ?? 0) > 0 ||
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.session?.activeTurnId != null ||
  thread.latestTurn?.state === "running" ||
  thread.backgroundLiveness === "working";
/** The two optional source fields a project carries on the wire and in storage. */
export type ProjectSourceFields = Pick<
  OrchestrationProjectShell,
  "onshapeSource" | "localCadSource"
>;
type OnshapeSource = NonNullable<ProjectSourceFields["onshapeSource"]>;
type LocalCadSource = NonNullable<ProjectSourceFields["localCadSource"]>;
/**
 * What a project reviews: an Onshape document, a CAD file in its folder, or only its folder. The
 * source types follow the input, so a narrowed project type stays narrowed.
 */
export type ProjectSource<O = OnshapeSource, L = LocalCadSource> =
  | { readonly kind: "onshape"; readonly source: O }
  | { readonly kind: "local-cad"; readonly source: L }
  | { readonly kind: "folder" };
/**
 * The project's kind. Branch on this instead of on the two fields.
 *
 * The decider never writes both fields: only `project.onshape.create` sets `onshapeSource`, and
 * `project.local-cad.set` rejects Onshape projects. Stored data with both is a defect, and the
 * Onshape source wins here because it marks a server-managed workspace, which nothing can undo.
 */
export const projectSource = <O = OnshapeSource, L = LocalCadSource>(project: {
  readonly onshapeSource?: O | undefined;
  readonly localCadSource?: L | undefined;
}): ProjectSource<O, L> =>
  project.onshapeSource !== undefined
    ? { kind: "onshape", source: project.onshapeSource }
    : project.localCadSource !== undefined
      ? { kind: "local-cad", source: project.localCadSource }
      : { kind: "folder" };
/** True when a project has a CAD source to sync and review, from Onshape or a local file. */
export const hasCadSource = (project: ProjectSourceFields): boolean =>
  projectSource(project).kind !== "folder";
export const initialCadProjectState = (): CadProjectState => ({
  enabled: true,
  catalog: null,
  roots: [],
  operation: null,
  lastOutcome: null,
});
export const CadOperationResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("discover"), catalog: CadCatalog }),
  Schema.Struct({
    kind: Schema.Literal("sync"),
    snapshot: CadSnapshotMetadata,
    // Local CAD syncs rescan the folder too, since that costs no API requests.
    catalog: Schema.optionalKey(CadCatalog),
  }),
  Schema.Struct({ kind: Schema.Literal("cleanup") }),
]);
