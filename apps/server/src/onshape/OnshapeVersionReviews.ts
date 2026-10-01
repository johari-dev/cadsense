import {
  type CadRootIdentity,
  type CadUserOperationError,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OnshapeVersionCheckInput,
  type OnshapeVersionCheckReason,
  type OnshapeVersionCheckResult,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Scope from "effect/Scope";

import { CadUserOperations } from "../cad/CadUserOperations.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ONSHAPE_API_BASE_PATH } from "./OnshapeApiPolicy.ts";
import { OnshapeConnections } from "./OnshapeConnections.ts";

/**
 * An "opened" check for a project that was checked more recently than this is skipped without
 * contacting Onshape. Manual checks ignore it. Onshape's annual API limit is a few thousand calls
 * per user, so opening and switching projects must not cost one call each.
 */
export const OPENED_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1_000;
/** A CAD sync that has not settled by then is reported as failed and the review starts anyway. */
const SYNC_TIMEOUT = "30 minutes";
const MAX_TITLE_LENGTH = 120;

/** The subset of Onshape's BTVersionInfo a check reads. Unknown fields are ignored. */
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
 * Pure check decision. Without a cursor the newest version becomes the baseline and nothing is
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
  /**
   * Starts the toggle listener inside the given scope: turning the setting on records the
   * baseline, turning it off drops it. Nothing here contacts Onshape on its own schedule.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Checks one project for new versions, from the client's project-opened hook or the settings
   * page's "Check now". Returns once the version list is read; reviews for new versions start in
   * the background. Never fails; Onshape errors come back as "failed" and start a backoff.
   */
  readonly check: (input: OnshapeVersionCheckInput) => Effect.Effect<OnshapeVersionCheckResult>;
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
  // Reviews started by a check run here so they outlive the request that found them.
  const scope = yield* Scope.Scope;
  // Overlap guard, failure backoff, and the "opened" throttle live in memory; the version cursor
  // is the durable state.
  const inflight = new Set<ProjectId>();
  const backoff = new Map<ProjectId, { readonly retryAtMs: number; readonly failures: number }>();
  const lastChecked = new Map<ProjectId, number>();

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

  // Reads the version list and decides. Without a cursor it only records the baseline. Reviews
  // are not started here so the caller can answer before the slow CAD sync runs.
  const plan = Effect.fn("OnshapeVersionReviews.plan")(function* (
    project: OrchestrationProjectShell,
  ) {
    const cursor = yield* readCursor(project.id);
    const versions = yield* listVersions(project);
    const decision = planVersionReviews({ cursor, versions });
    if (decision.baseline) yield* writeCursor(project.id, decision.baseline);
    return decision.pending;
  });

  // Starts each pending review oldest first. The cursor advances after each start, so a failure
  // stops at that version and the next check retries it.
  const review = Effect.fn("OnshapeVersionReviews.review")(function* (
    project: OrchestrationProjectShell,
    pending: ReadonlyArray<{ readonly version: OnshapeVersion; readonly ordinal: number }>,
  ) {
    for (const { version, ordinal } of pending) {
      yield* startReview(project, version, ordinal);
      yield* writeCursor(project.id, { versionId: version.id, createdAt: version.createdAt });
    }
  });

  // Records the failure and returns when the project may contact Onshape again.
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
      yield* Effect.logWarning("Onshape version check failed", {
        projectId,
        retryInMs: delayMs,
        cause: Cause.pretty(cause),
      });
      return nowMs + delayMs;
    });

  const recover = <A>(projectId: ProjectId, onFailure: (retryAtMs: number) => A) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : noteFailure(projectId, cause).pipe(Effect.map(onFailure)),
    );
  const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

  // One check for one enabled project. Skips without contacting Onshape while another check or
  // review for the project is running, while backing off, and for throttled "opened" checks.
  const checkEnabled = Effect.fn("OnshapeVersionReviews.checkEnabled")(function* (
    project: OrchestrationProjectShell,
    reason: OnshapeVersionCheckReason,
  ): Effect.fn.Return<OnshapeVersionCheckResult> {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (inflight.has(project.id)) return { status: "skipped", reason: "in-progress" };
    const retryAtMs = backoff.get(project.id)?.retryAtMs ?? 0;
    if (retryAtMs > nowMs) return { status: "backing-off", retryAt: isoAt(retryAtMs) };
    if (
      reason === "opened" &&
      nowMs - (lastChecked.get(project.id) ?? -Infinity) < OPENED_CHECK_INTERVAL_MS
    )
      return { status: "skipped", reason: "throttled" };
    inflight.add(project.id);
    lastChecked.set(project.id, nowMs);
    // Set once a background review owns the in-flight mark; until then this check releases it.
    let handedOff = false;
    const release = Effect.sync(() => inflight.delete(project.id));
    const succeeded = Effect.sync(() => backoff.delete(project.id));
    return yield* Effect.gen(function* () {
      const planned = yield* plan(project).pipe(
        Effect.map((pending) => ({ ok: true as const, pending })),
        recover(project.id, (retryAtMs) => ({ ok: false as const, retryAtMs })),
      );
      if (!planned.ok) return { status: "failed" as const, retryAt: isoAt(planned.retryAtMs) };
      if (planned.pending.length === 0) {
        yield* succeeded;
        return { status: "no-new-versions" as const };
      }
      yield* review(project, planned.pending).pipe(
        Effect.andThen(succeeded),
        recover(project.id, () => undefined),
        Effect.ensuring(release),
        Effect.forkIn(scope),
      );
      handedOff = true;
      return {
        status: "reviewing" as const,
        versions: planned.pending.map(({ version, ordinal }) => ({
          ordinal,
          name: version.name.trim() || version.id,
        })),
      };
    }).pipe(Effect.ensuring(Effect.suspend(() => (handedOff ? Effect.void : release))));
  });

  const check: OnshapeVersionReviewsShape["check"] = ({ projectId, reason }) =>
    snapshots.getProjectShellById(projectId).pipe(
      Effect.flatMap(
        (project): Effect.Effect<OnshapeVersionCheckResult> =>
          Option.isSome(project) && enabled(project.value)
            ? checkEnabled(project.value, reason)
            : Effect.succeed({ status: "skipped", reason: "disabled" }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.gen(function* () {
              yield* Effect.logWarning("Onshape version check could not read the project", {
                projectId,
                cause: Cause.pretty(cause),
              });
              const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
              return { status: "failed" as const, retryAt: isoAt(nowMs) };
            }),
      ),
    );

  // Turning the setting on records the baseline right away, bypassing the "opened" throttle;
  // turning it off drops the cursor so a later re-enable starts a fresh baseline instead of
  // reviewing the gap.
  const onToggle = Effect.fn("OnshapeVersionReviews.onToggle")(function* (
    projectId: ProjectId,
    on: boolean,
  ) {
    if (on) return yield* check({ projectId, reason: "manual" }).pipe(Effect.asVoid);
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
    });

  return OnshapeVersionReviews.of({ start, check });
});

export const layer = Layer.effect(OnshapeVersionReviews, make);
