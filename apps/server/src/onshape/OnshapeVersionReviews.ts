import {
  type CadRootIdentity,
  type CadUserOperationError,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  OnshapeWorkspaceId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  ProviderInstanceId,
  type ProjectId,
  ThreadId,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Scope from "effect/Scope";

import { CadUserOperations } from "../cad/CadUserOperations.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";
import { OnshapeConnections } from "./OnshapeConnections.ts";

/** Every enabled project lists its document versions this often; jitter spreads the requests. */
export const ONSHAPE_VERSION_POLL_INTERVAL = "5 minutes";
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1_000;
/** A CAD sync that has not settled by then is reported as failed and the review starts anyway. */
const SYNC_TIMEOUT = "30 minutes";
const MAX_TITLE_LENGTH = 120;

/** The subset of Onshape's BTVersionInfo the poller reads. Unknown fields are ignored. */
export const OnshapeVersion = Schema.Struct({
  id: OnshapeWorkspaceId,
  name: Schema.String,
  createdAt: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  creator: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
  microversion: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type OnshapeVersion = typeof OnshapeVersion.Type;
const OnshapeVersionList = Schema.Union([
  Schema.Array(OnshapeVersion),
  Schema.Struct({ items: Schema.Array(OnshapeVersion) }),
]);
const decodeVersionList = Schema.decodeUnknownEffect(OnshapeVersionList);
const hasRetryAfter = Schema.is(Schema.Struct({ retryAfterSeconds: Schema.Number }));

/** Newest version a project has already accounted for. Null means no baseline yet. */
export interface VersionCursor {
  readonly versionId: string;
  readonly createdAt: string;
}

const compareVersions = (a: OnshapeVersion, b: OnshapeVersion) =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/**
 * Pure poll decision. Without a cursor the newest version becomes the baseline and nothing is
 * reviewed. With one, every version created after it is pending, oldest first, along with its
 * ordinal in the document's version history (the initial "Start" version is v0).
 */
export function planVersionReviews(input: {
  readonly cursor: VersionCursor | null;
  readonly versions: ReadonlyArray<OnshapeVersion>;
}): {
  readonly baseline: VersionCursor | null;
  readonly pending: ReadonlyArray<{ readonly version: OnshapeVersion; readonly ordinal: number }>;
} {
  const sorted = [...input.versions].sort(compareVersions);
  const newest = sorted.at(-1);
  if (input.cursor === null) {
    return {
      baseline: newest ? { versionId: newest.id, createdAt: newest.createdAt } : null,
      pending: [],
    };
  }
  const cursor = input.cursor;
  return {
    baseline: null,
    pending: sorted.flatMap((version, ordinal) =>
      version.createdAt > cursor.createdAt ||
      (version.createdAt === cursor.createdAt && version.id > cursor.versionId)
        ? [{ version, ordinal }]
        : [],
    ),
  };
}

export function versionReviewTitle(version: OnshapeVersion, ordinal: number): string {
  const title = `Review v${ordinal}: ${version.name.trim() || version.id}`;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

/** What the CAD panel will show when the review starts. */
export type VersionSyncOutcome =
  | { readonly status: "no-roots" }
  | { readonly status: "synced"; readonly microversionId: string | null }
  | { readonly status: "failed"; readonly reason: string };

const syncLine = (version: OnshapeVersion, sync: VersionSyncOutcome): ReadonlyArray<string> => {
  switch (sync.status) {
    case "no-roots":
      return [
        "No CAD root has been synced for this project yet, so the CAD panel has nothing to show until one is synced in project settings.",
      ];
    case "failed":
      return [
        `The CAD download failed (${sync.reason}), so the CAD panel may show an older revision.`,
      ];
    case "synced":
      return [
        sync.microversionId
          ? `The CAD panel shows a snapshot synced just now from the bound workspace at microversion ${sync.microversionId}.`
          : "The CAD panel shows a snapshot synced just now from the bound workspace.",
        ...(version.microversion &&
        sync.microversionId &&
        version.microversion !== sync.microversionId
          ? [
              `The workspace has moved on since this version (version microversion ${version.microversion}), so some geometry may be newer than the version.`,
            ]
          : []),
      ];
  }
};

export function versionReviewPrompt(input: {
  readonly project: OrchestrationProjectShell;
  readonly version: OnshapeVersion;
  readonly sync: VersionSyncOutcome;
}): string {
  const { project, version, sync } = input;
  const source = project.onshapeSource;
  const link = source
    ? new URL(`/documents/${source.documentId}/v/${version.id}`, source.host).href
    : null;
  const creator = version.creator?.name?.trim() || "an unknown user";
  const note = version.description?.trim() || "none";
  return [
    `Onshape version "${version.name.trim() || version.id}" was created on ${version.createdAt} by ${creator}.`,
    `Version note: ${note}.`,
    `Review this version of ${project.title} and leave CAD comments.`,
    ...syncLine(version, sync),
    ...(link ? [`Version link: ${link}`] : []),
  ].join("\n");
}

export interface OnshapeVersionReviewsShape {
  /** Starts the periodic poll and the toggle listener inside the given scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Polls every enabled project once. Never fails; problems are logged and retried later. */
  readonly pollAll: () => Effect.Effect<void>;
  /** Polls one project once, if it is enabled. */
  readonly pollProject: (projectId: ProjectId) => Effect.Effect<void>;
}

export class OnshapeVersionReviews extends Context.Service<
  OnshapeVersionReviews,
  OnshapeVersionReviewsShape
>()("@cadsense/server/onshape/OnshapeVersionReviews") {}

interface CursorRow {
  readonly versionId: string;
  readonly createdAt: string;
}

const syncFailureReason = (error: CadUserOperationError): string => {
  switch (error.reason) {
    case "busy":
      return "CAD is busy with an agent run or another CAD operation";
    case "throttled":
      return "Onshape requests are throttled";
    case "disk-space":
      return "not enough free disk space";
    case "not-found":
    case "unavailable":
    case "invalid-root":
      return "the CAD root is unavailable";
    case "operation-failed":
      return "the CAD operation failed";
  }
};

const isCadStateSet = (
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: "project.cad-state-set" }> =>
  event.type === "project.cad-state-set";

const enabled = (project: OrchestrationProjectShell) =>
  project.onshapeSource?.autoReviewVersions === true &&
  project.onshapeSource.managedWorkspaceReady === true;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* OnshapeConnections;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const cadOperations = yield* CadUserOperations;
  const crypto = yield* Crypto.Crypto;
  // Overlap guard and failure backoff live in memory; the version cursor is the durable state.
  const inflight = new Set<ProjectId>();
  const backoff = new Map<ProjectId, { readonly retryAtMs: number; readonly failures: number }>();

  const readCursor = (projectId: ProjectId) =>
    sql<CursorRow>`
      SELECT version_id AS "versionId", version_created_at AS "createdAt"
      FROM onshape_version_review_cursors
      WHERE project_id = ${projectId}
    `.pipe(Effect.map((rows): VersionCursor | null => rows[0] ?? null));

  const writeCursor = (projectId: ProjectId, cursor: VersionCursor) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO onshape_version_review_cursors
          (project_id, version_id, version_created_at, updated_at)
        VALUES (${projectId}, ${cursor.versionId}, ${cursor.createdAt}, ${updatedAt})
        ON CONFLICT (project_id) DO UPDATE SET
          version_id = excluded.version_id,
          version_created_at = excluded.version_created_at,
          updated_at = excluded.updated_at
      `;
    });

  const clearCursor = (projectId: ProjectId) =>
    sql`DELETE FROM onshape_version_review_cursors WHERE project_id = ${projectId}`.pipe(
      Effect.asVoid,
    );

  const listVersions = Effect.fn("OnshapeVersionReviews.listVersions")(function* (
    project: OrchestrationProjectShell,
  ) {
    const source = project.onshapeSource;
    if (!source) return [];
    const body = yield* connections.readJson({
      connectionId: source.connectionId,
      host: source.host,
      path: `${ONSHAPE_API_BASE_PATH}/documents/d/${source.documentId}/versions`,
      query: "",
    });
    const decoded = yield* decodeVersionList(body);
    return "items" in decoded ? decoded.items : decoded;
  });

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));

  // Runs the same sync the settings page triggers for one already-synced root and waits for its
  // outcome event. The sync targets the bound workspace; snapshots cannot be pinned to a version.
  const syncRoot = Effect.fn("OnshapeVersionReviews.syncRoot")(function* (
    project: OrchestrationProjectShell,
    root: CadRootIdentity,
  ): Effect.fn.Return<VersionSyncOutcome> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* engine.subscribeDomainEvents;
        const started = yield* cadOperations
          .start({
            projectId: project.id,
            kind: "sync",
            root: { elementId: root.elementId, kind: root.kind, configuration: root.configuration },
          })
          .pipe(Effect.result);
        if (Result.isFailure(started))
          return { status: "failed" as const, reason: syncFailureReason(started.failure) };
        const settled = yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter(isCadStateSet),
          Stream.filter(
            (event) =>
              event.payload.projectId === project.id &&
              event.payload.cad.operation === null &&
              event.payload.cad.lastOutcome?.operationId === started.success.operationId,
          ),
          Stream.runHead,
          Effect.timeoutOption(SYNC_TIMEOUT),
          Effect.map(Option.flatten),
        );
        if (Option.isNone(settled))
          return { status: "failed" as const, reason: "the CAD sync timed out" };
        const cad = settled.value.payload.cad;
        if (cad.lastOutcome?.status !== "succeeded")
          return {
            status: "failed" as const,
            reason: cad.lastOutcome?.reason ?? "the CAD operation failed",
          };
        return {
          status: "synced" as const,
          microversionId:
            cad.roots.find((entry) => entry.rootId === root.rootId)?.current?.microversionId ??
            null,
        };
      }),
    );
  });

  const syncSnapshots = Effect.fn("OnshapeVersionReviews.syncSnapshots")(function* (
    project: OrchestrationProjectShell,
  ): Effect.fn.Return<VersionSyncOutcome> {
    const roots = project.cad?.roots ?? [];
    if (roots.length === 0) return { status: "no-roots" as const };
    let outcome: VersionSyncOutcome = { status: "no-roots" };
    for (const root of roots) {
      const result = yield* syncRoot(project, root);
      if (result.status === "failed") return result;
      outcome = result;
    }
    return outcome;
  });

  // Mirrors the client's bootstrap turn start: sync the CAD snapshot, create the thread, then
  // start its first turn. The thread id is derived from the version so a retry reuses the thread.
  const startReview = Effect.fn("OnshapeVersionReviews.startReview")(function* (
    project: OrchestrationProjectShell,
    version: OnshapeVersion,
    ordinal: number,
  ) {
    const sync = yield* syncSnapshots(project);
    const threadId = ThreadId.make(`onshape-version-review:${project.id}:${version.id}`);
    const modelSelection = project.defaultModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    };
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const existing = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(existing)) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* commandId("onshape-version-review-create"),
        threadId,
        projectId: project.id,
        title: versionReviewTitle(version, ordinal),
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      });
    }
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("onshape-version-review-turn"),
      threadId,
      message: {
        messageId: MessageId.make(`onshape-version-review:${project.id}:${version.id}`),
        role: "user",
        text: versionReviewPrompt({ project, version, sync }),
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt,
    });
    yield* Effect.logInfo("Onshape version review started", {
      projectId: project.id,
      versionId: version.id,
      threadId,
      sync: sync.status,
    });
  });

  const poll = Effect.fn("OnshapeVersionReviews.poll")(function* (
    project: OrchestrationProjectShell,
  ) {
    const cursor = yield* readCursor(project.id);
    const versions = yield* listVersions(project);
    const plan = planVersionReviews({ cursor, versions });
    if (cursor === null) {
      if (plan.baseline) yield* writeCursor(project.id, plan.baseline);
      return;
    }
    for (const { version, ordinal } of plan.pending) {
      yield* startReview(project, version, ordinal);
      yield* writeCursor(project.id, { versionId: version.id, createdAt: version.createdAt });
    }
  });

  const noteFailure = (projectId: ProjectId, cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const error = Option.getOrUndefined(Cause.findErrorOption(cause));
      const failures = (backoff.get(projectId)?.failures ?? 0) + 1;
      const retryAfterSeconds =
        hasRetryAfter(error) && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : undefined;
      const delayMs =
        retryAfterSeconds !== undefined
          ? retryAfterSeconds * 1_000
          : Math.min(MAX_RETRY_BACKOFF_MS, 5 * 60 * 1_000 * 2 ** (failures - 1));
      backoff.set(projectId, { retryAtMs: nowMs + delayMs, failures });
      yield* Effect.logWarning("Onshape version poll failed", {
        projectId,
        retryInMs: delayMs,
        cause: Cause.pretty(cause),
      });
    });

  const pollGuarded = (project: OrchestrationProjectShell) =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (inflight.has(project.id) || (backoff.get(project.id)?.retryAtMs ?? 0) > nowMs) return;
      inflight.add(project.id);
      yield* poll(project).pipe(
        Effect.tap(() => Effect.sync(() => backoff.delete(project.id))),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : noteFailure(project.id, cause),
        ),
        Effect.ensuring(Effect.sync(() => inflight.delete(project.id))),
      );
    });

  const pollProject: OnshapeVersionReviewsShape["pollProject"] = (projectId) =>
    snapshots.getProjectShellById(projectId).pipe(
      Effect.flatMap((project) =>
        Option.isSome(project) && enabled(project.value) ? pollGuarded(project.value) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Onshape version poll could not read the project", {
              projectId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const pollAll: OnshapeVersionReviewsShape["pollAll"] = () =>
    snapshots.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(snapshot.projects.filter(enabled), pollGuarded, { discard: true }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Onshape version poll could not list projects", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

  // Turning the setting on polls right away so the baseline is recorded; turning it off drops
  // the cursor so a later re-enable starts a fresh baseline instead of reviewing the gap.
  const onToggle = Effect.fn("OnshapeVersionReviews.onToggle")(function* (
    projectId: ProjectId,
    on: boolean,
  ) {
    if (on) return yield* pollProject(projectId);
    yield* clearCursor(projectId).pipe(
      Effect.catch(() =>
        Effect.logWarning("Onshape version review cursor could not be cleared", { projectId }),
      ),
    );
  });

  const start: OnshapeVersionReviewsShape["start"] = () =>
    Effect.gen(function* () {
      const subscription = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(Stream.fromSubscription(subscription), (event) =>
          event.type === "project.meta-updated" &&
          event.payload.onshapeAutoReviewVersions !== undefined
            ? onToggle(event.payload.projectId, event.payload.onshapeAutoReviewVersions)
            : Effect.void,
        ),
      );
      yield* forkParked(
        pollAll().pipe(
          Effect.repeat(Schedule.spaced(ONSHAPE_VERSION_POLL_INTERVAL).pipe(Schedule.jittered)),
        ),
      );
    });

  return OnshapeVersionReviews.of({ start, pollAll, pollProject });
});

export const layer = Layer.effect(OnshapeVersionReviews, make);
