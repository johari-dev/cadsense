import * as DateTime from "effect/DateTime";
// @effect-diagnostics nodeBuiltinImport:off
// Cryptographic identities are computed only at this trusted server boundary.
import * as NodeCrypto from "node:crypto";
import {
  CadRenderError,
  CadCommentError,
  CadCommentPublication,
  CadCommentsListInput,
  CadCommentsPublishInput,
  CadCommentLocateInput,
  CadCommentInspectInput,
  CadCommentReviewInput,
  CadReviewLearningRemoveInput,
  CadCaptureRecord,
  CadViewState,
  CAD_COMMENTS_PUBLISHED_ACTIVITY,
  CommandId,
  EventId,
  type CadCommentsPublishedCard,
  ProjectId,
  type CadComment,
  type CadCommentsCatalog,
  cadCommentsCatalog,
  type CadCommentOutdatedReason,
  type CadCommentProposed,
  type CadCommentReceipt,
  type CadCommentTarget,
  type CadReviewLearning,
  type CadSnapshotManifest,
  type CadCommentRenderWork,
  type ThreadId,
  type TurnId,
  CAD_CAPTURE_SIZE,
} from "@cadsense/contracts";
import { canonicalCadJson, cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { CadSnapshotStore } from "./CadSnapshotStore.ts";
import { CadRenderBroker } from "./CadRenderBroker.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import {
  readThreadCadCommentCaptureViews,
  readThreadCadComments,
} from "./CadCommentPersistence.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { pruneCadCommentEvidence } from "./CadCommentEvidence.ts";
import { cadCommentOutdatedCheck } from "./CadCommentOutdated.ts";

const fail = (reason: string) => new CadCommentError({ reason });
const isCommentError = Schema.is(CadCommentError);
const isRenderError = Schema.is(CadRenderError);
const isInvariantError = Schema.is(OrchestrationCommandInvariantError);
const error = (cause: unknown) =>
  isCommentError(cause)
    ? cause
    : isInvariantError(cause)
      ? fail(cause.detail)
      : isRenderError(cause)
        ? fail(`render-${cause.reason}`)
        : fail(cause instanceof Error && cause.message ? cause.message : "unavailable");
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
/** A chat's retained evidence: `<inspectionId>.png` and `.json` for each published inspection. */
export const cadCommentEvidenceDirectory = (path: Path.Path, stateDir: string, threadId: string) =>
  path.join(stateDir, "cad", "comment-evidence", digest(threadId));
const uuid = () => NodeCrypto.randomUUID();
// Include recovery guidance in responses: resumed providers can retain older descriptions.
const inputGuidance = (schema: Schema.Top) =>
  schema === CadCommentPublication
    ? 'New item: {kind:"new",publicationKey,inspectedSnapshotId,title,body,severity,category,targets:[{kind:"point",label,candidateId,inspectionId,confirmationReason}]}. severity is blocker|concern|question|nit; category is interference|access|assembly|wiring|structure|manufacturing|other. Use snapshotId from the inspected capture. Precise targets require locate then visual verification of inspect. Whole-part fallback target: {kind:"part",label,occurrenceId,preciseLocationLimitation}, inside targets. Reuse item: {kind:"reuse",publicationKey,inspectedSnapshotId,reuseCommentId}. Resolution proposal: {kind:"propose-resolve",publicationKey,inspectedSnapshotId,commentId,explanation}.'
    : schema === CadCommentLocateInput
      ? `Input: {captureId,picks:[{pickKey,intendedOccurrenceId,x,y}]}. Use x/y in original ${CAD_CAPTURE_SIZE.width} by ${CAD_CAPTURE_SIZE.height} image pixels, not pixelX/pixelY.`
      : "";
const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input, { errors: "all" }).pipe(
    Effect.mapError(
      (cause) =>
        new CadCommentError({
          reason: "invalid-input",
          details: [cause.message.slice(0, 6000), inputGuidance(schema)].filter(Boolean).join("\n"),
        }),
    ),
  );
export interface CadCommentDelivery {
  readonly result: unknown;
  readonly png?: Uint8Array;
}
export interface CadCommentActivation {
  readonly invoke: (
    name: string,
    input: unknown,
  ) => Effect.Effect<CadCommentDelivery, CadCommentError>;
}
export class CadComments extends Context.Service<
  CadComments,
  {
    readonly activate: (
      threadId: ThreadId,
      contextId: string,
      turnId: TurnId,
    ) => Effect.Effect<CadCommentActivation, CadCommentError, Scope.Scope>;
    readonly watch: (threadId: ThreadId) => Stream.Stream<CadCommentsCatalog, CadCommentError>;
    readonly review: (
      input: typeof CadCommentReviewInput.Type,
    ) => Effect.Effect<CadComment, CadCommentError>;
    readonly learnings: (
      projectId: ProjectId,
    ) => Stream.Stream<readonly CadReviewLearning[], CadCommentError>;
    readonly removeLearning: (
      input: typeof CadReviewLearningRemoveInput.Type,
    ) => Effect.Effect<void, CadCommentError>;
  }
>()("@cadsense/server/cad/CadComments") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient,
    query = yield* ProjectionSnapshotQuery,
    engine = yield* OrchestrationEngineService;
  const store = yield* CadSnapshotStore,
    broker = yield* CadRenderBroker,
    fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    config = yield* ServerConfig;
  const activeEvidence = new Set<string>();
  const evidenceRoot = path.join(config.stateDir, "cad", "comment-evidence");
  yield* forkParked(
    pruneCadCommentEvidence(evidenceRoot, activeEvidence).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("CAD comment evidence recovery remains pending", cause),
      ),
    ),
  );
  const removeDeletedEvidence = Effect.gen(function* () {
    const model = yield* query.getCommandReadModel();
    for (const thread of model.threads)
      if (
        thread.deletedAt !== null ||
        model.projects.some((p) => p.id === thread.projectId && p.deletedAt !== null)
      )
        yield* fs.remove(cadCommentEvidenceDirectory(path, config.stateDir, thread.id), {
          recursive: true,
          force: true,
        });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("CAD comment evidence cleanup remains pending", cause),
    ),
  );
  const events = yield* engine.subscribeDomainEvents;
  yield* forkParked(
    Stream.fromSubscription(events).pipe(
      Stream.filter((e) => e.type === "thread.deleted" || e.type === "project.deleted"),
      Stream.runForEach(() => removeDeletedEvidence),
    ),
  );
  // Current snapshot last compared per project root, so unrelated CAD state changes cost nothing.
  const compared = new Map<string, string>();
  /**
   * Annotates open comments on each root whose current snapshot changed since the last pass, or
   * only the given comments when they were just published against an older snapshot.
   */
  const reconcileOutdated = Effect.fn("CadComments.reconcileOutdated")(
    function* (projectId: ProjectId, only?: ReadonlySet<string>) {
      const model = yield* query.getCommandReadModel();
      const project = model.projects.find((p) => p.id === projectId && p.deletedAt === null);
      if (!project?.cad) return;
      const threads = new Set(
        model.threads
          .filter((t) => t.projectId === projectId && t.deletedAt === null)
          .map((t) => t.id),
      );
      const manifests = new Map<string, CadSnapshotManifest | null>();
      const load = Effect.fn("CadComments.loadManifest")(function* (snapshotId: string) {
        const cached = manifests.get(snapshotId);
        if (cached !== undefined) return cached;
        const loaded = yield* store
          .withPinned(snapshotId, (m) => Effect.succeed(m))
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("CAD comment snapshot unavailable for outdated check", {
                snapshotId,
                cause,
              }),
            ),
            Effect.option,
          );
        manifests.set(snapshotId, Option.getOrNull(loaded));
        return Option.getOrNull(loaded);
      });
      for (const root of project.cad.roots) {
        const current = root.current?.snapshotId;
        const key = `${projectId}:${root.rootId}`;
        if (!current || (!only && compared.get(key) === current)) continue;
        const to = yield* load(current);
        if (!to) continue;
        const entries = new Map<
          ThreadId,
          { commentId: string; reason: CadCommentOutdatedReason | null }[]
        >();
        // One cad_diff per (comment snapshot, current snapshot) pair, shared by its comments.
        const checks = new Map<string, ReturnType<typeof cadCommentOutdatedCheck>>();
        for (const comment of model.cadComments ?? []) {
          if (
            comment.state !== "open" ||
            comment.rootId !== root.rootId ||
            !threads.has(comment.threadId) ||
            (only && !only.has(comment.id))
          )
            continue;
          let reason: CadCommentOutdatedReason | null = null;
          if (comment.snapshotId !== current) {
            let check = checks.get(comment.snapshotId);
            if (!check) {
              const from = yield* load(comment.snapshotId);
              if (!from) continue;
              check = cadCommentOutdatedCheck(from, to);
              checks.set(comment.snapshotId, check);
            }
            reason = check(comment);
          }
          if (reason === (comment.outdated?.reason ?? null)) continue;
          entries.set(comment.threadId, [
            ...(entries.get(comment.threadId) ?? []),
            { commentId: comment.id, reason },
          ]);
        }
        for (const [threadId, list] of entries)
          yield* engine
            .dispatch({
              type: "thread.cad.comments.outdate",
              commandId: CommandId.make(uuid()),
              threadId,
              snapshotId: current,
              entries: list,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("CAD comment outdated annotation was not recorded", {
                  threadId,
                  cause,
                }),
              ),
            );
        if (!only) compared.set(key, current);
      }
    },
    Effect.catch((cause) => Effect.logWarning("CAD comment outdated check remains pending", cause)),
  );
  const snapshotChanges = yield* engine.subscribeDomainEvents;
  yield* forkParked(
    Effect.gen(function* () {
      const model = yield* query.getCommandReadModel();
      for (const project of model.projects) yield* reconcileOutdated(project.id);
    }).pipe(
      Effect.andThen(
        Stream.fromSubscription(snapshotChanges).pipe(
          Stream.runForEach((e) =>
            e.type === "project.cad-state-set"
              ? reconcileOutdated(e.payload.projectId)
              : e.type === "thread.cad-comments-committed" && e.payload.comments.length
                ? Effect.gen(function* () {
                    const model = yield* query.getCommandReadModel();
                    const thread = model.threads.find((t) => t.id === e.payload.threadId);
                    if (thread)
                      yield* reconcileOutdated(
                        thread.projectId,
                        new Set(e.payload.comments.map((c) => c.id)),
                      );
                  })
                : Effect.void,
          ),
        ),
      ),
    ),
  );
  const owner = Effect.fn("CadComments.owner")(function* (threadId: ThreadId) {
    const rows =
      yield* sql`SELECT project_id FROM projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL`;
    if (!rows[0]) return yield* fail("comment-unavailable");
    const projectId = yield* decode(ProjectId, rows[0].project_id);
    const project = yield* query.getProjectShellById(projectId);
    if (Option.isNone(project)) return yield* fail("comment-unavailable");
    return project.value;
  });
  const read = Effect.fn("CadComments.read")(function* (threadId: ThreadId) {
    yield* owner(threadId);
    return yield* readThreadCadComments(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });
  // Captures are durable, so a catalog read replays the view behind every point target.
  const catalog = Effect.fn("CadComments.catalog")(function* (threadId: ThreadId) {
    const comments = yield* read(threadId);
    const views = yield* readThreadCadCommentCaptureViews(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return cadCommentsCatalog(comments, views);
  });
  const watch = (threadId: ThreadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        return Stream.concat(
          Stream.fromEffect(catalog(threadId)),
          Stream.fromSubscription(events).pipe(
            Stream.filter(
              (e) =>
                e.type === "project.deleted" ||
                (e.aggregateId === threadId &&
                  (e.type === "thread.cad-comments-committed" ||
                    e.type === "thread.cad-comment-reviewed" ||
                    e.type === "thread.cad-comments-outdated" ||
                    e.type === "thread.deleted")),
            ),
            Stream.mapEffect(() => catalog(threadId)),
          ),
        );
      }),
    ).pipe(Stream.mapError(error));
  const review = Effect.fn("CadComments.review")(function* (
    rawInput: typeof CadCommentReviewInput.Type,
  ) {
    // A whitespace-only reason is no reason: it neither persists nor becomes a learning.
    const { reason: rawReason, ...rest } = rawInput;
    const reason = rawReason?.trim();
    const input = { ...rest, ...(reason ? { reason } : {}) };
    yield* owner(input.threadId);
    const model = yield* query.getCommandReadModel();
    const hash = digest(
      canonicalCadJson({
        commentId: input.commentId,
        expectedVersion: input.expectedVersion,
        state: input.state,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    );
    const prior = model.cadCommentReviews?.find((r) => r.commandId === input.commandId);
    if (prior && (prior.threadId !== input.threadId || prior.payloadHash !== hash))
      return yield* fail("idempotency-conflict");
    if (!prior)
      yield* engine
        .dispatch({ ...input, type: "thread.cad.comment.review", payloadHash: hash })
        .pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const currentComment = (yield* read(input.threadId)).find(
                (c) => c.id === input.commentId,
              );
              const failure = error(cause);
              return yield* new CadCommentError({
                ...failure,
                ...(currentComment ? { currentComment } : {}),
              });
            }),
          ),
        );
    const result = (yield* read(input.threadId)).find((c) => c.id === input.commentId);
    if (!result) return yield* fail("comment-unavailable");
    return prior ? { ...result, state: prior.state, version: prior.version } : result;
  }, Effect.mapError(error));
  const readLearnings = Effect.fn("CadComments.readLearnings")(function* (projectId: ProjectId) {
    if (Option.isNone(yield* query.getProjectShellById(projectId)))
      return yield* fail("project-unavailable");
    return yield* query.getCadReviewLearnings(projectId);
  });
  const learnings = (projectId: ProjectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        return Stream.concat(
          Stream.fromEffect(readLearnings(projectId)),
          Stream.fromSubscription(events).pipe(
            Stream.filter(
              (e) =>
                e.aggregateId === projectId &&
                (e.type === "project.cad-review-learning-added" ||
                  e.type === "project.cad-review-learning-removed" ||
                  e.type === "project.deleted"),
            ),
            Stream.mapEffect(() => readLearnings(projectId)),
          ),
        );
      }),
    ).pipe(Stream.mapError(error));
  const removeLearning = Effect.fn("CadComments.removeLearning")(function* (
    input: typeof CadReviewLearningRemoveInput.Type,
  ) {
    yield* readLearnings(input.projectId);
    yield* engine.dispatch({ ...input, type: "project.cad.review-learning.remove" });
  }, Effect.mapError(error));

  const activate = Effect.fn("CadComments.activate")(function* (
    threadId: ThreadId,
    contextId: string,
    turnId: TurnId,
  ) {
    yield* owner(threadId);
    const scope = yield* Scope.Scope;
    const creationSequence = Effect.gen(function* () {
      const rows =
        yield* sql`SELECT MAX(sequence) AS sequence FROM orchestration_events WHERE stream_id=${threadId} AND event_type='thread.created'`;
      return rows[0]?.sequence;
    });
    const incarnation = yield* creationSequence;
    const checkOwner = Effect.gen(function* () {
      yield* owner(threadId);
      if ((yield* creationSequence) !== incarnation) return yield* fail("comment-unavailable");
    });
    const deleted = yield* Deferred.make<never, CadCommentError>();
    const lifecycle = yield* engine.subscribeDomainEvents;
    yield* Stream.fromSubscription(lifecycle).pipe(
      Stream.filter(
        (e) =>
          (e.aggregateId === threadId &&
            (e.type === "thread.deleted" || e.type === "thread.created")) ||
          e.type === "project.deleted",
      ),
      Stream.runForEach(() =>
        checkOwner.pipe(Effect.catch(() => Deferred.fail(deleted, fail("comment-unavailable")))),
      ),
      Effect.forkIn(scope),
    );
    type Binding = {
      manifest: CadSnapshotManifest;
      readAsset: (hash: string) => Effect.Effect<Uint8Array, CadCommentError>;
    };
    const bindings = new Map<string, Binding>();
    type Candidate = {
      id: string;
      captureId: string;
      state: CadViewState;
      binding: Binding;
      occurrenceId: string;
      point: readonly [number, number, number];
      normal: readonly [number, number, number] | null;
      inspectionIds: Set<string>;
    };
    const candidates = new Map<string, Candidate>();
    const evidenceDirectory = cadCommentEvidenceDirectory(path, config.stateDir, threadId);
    const evidenceIds = new Set<string>();
    const cleanupEvidence = Effect.gen(function* () {
      const model = yield* query.getCommandReadModel();
      const live = model.threads.some(
        (t) =>
          t.id === threadId &&
          t.deletedAt === null &&
          model.projects.some((p) => p.id === t.projectId && p.deletedAt === null),
      );
      const retained = new Set(
        (model.cadComments ?? [])
          .filter((c) => live && c.threadId === threadId)
          .flatMap((c) => c.targets.flatMap((t) => (t.kind === "point" ? [t.inspectionId] : []))),
      );
      for (const id of evidenceIds)
        if (!retained.has(id))
          for (const extension of ["png", "json"])
            yield* fs.remove(path.join(evidenceDirectory, `${id}.${extension}`), { force: true });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not clean unpublished CAD comment evidence", cause),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          for (const id of evidenceIds) activeEvidence.delete(id);
        }),
      ),
    );
    yield* Effect.addFinalizer(() => cleanupEvidence);
    let active = true;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        active = false;
        candidates.clear();
        bindings.clear();
      }),
    );
    const bind = Effect.fn("CadComments.bind")(function* (snapshotId: string) {
      const existing = bindings.get(snapshotId);
      if (existing) return existing;
      const project = yield* owner(threadId);
      const session =
        yield* sql`SELECT view_json FROM projection_cad_sessions WHERE context_id=${contextId} AND thread_id=${threadId}`;
      const saved = session[0]?.view_json;
      const view = saved ? yield* decode(Schema.fromJsonString(CadViewState), saved) : null;
      const ownCaptures =
        yield* sql`SELECT capture_id FROM projection_cad_captures WHERE thread_id=${threadId} AND json_extract(record_json,'$.capture.snapshotId')=${snapshotId} LIMIT 1`;
      if (
        view?.snapshotId !== snapshotId &&
        !ownCaptures.length &&
        !project.cad?.roots.some(
          (r) => r.current?.snapshotId === snapshotId || r.rollback?.snapshotId === snapshotId,
        )
      )
        return yield* fail("snapshot-unavailable");
      const ready = yield* Deferred.make<Binding, CadCommentError>();
      yield* store
        .withPinned(snapshotId, (manifest, readAsset) =>
          Effect.gen(function* () {
            if (manifest.projectId !== project.id) return yield* fail("snapshot-unavailable");
            // Verify every asset before acknowledging a retained, durable model.
            for (const asset of manifest.assets) yield* readAsset(asset.sha256);
            yield* Deferred.succeed(ready, {
              manifest,
              readAsset: (hash) => readAsset(hash).pipe(Effect.mapError(error)),
            });
            return yield* Effect.never;
          }),
        )
        .pipe(
          Effect.catch((cause) => Deferred.fail(ready, error(cause))),
          Effect.forkIn(scope),
        );
      const result = yield* Deferred.await(ready);
      bindings.set(snapshotId, result);
      return result;
    });
    const render = Effect.fn("CadComments.render")(function* (
      binding: Binding,
      state: CadViewState,
      commentWork: CadCommentRenderWork,
    ) {
      return yield* broker.capture({
        threadId,
        sessionId: contextId,
        runId: turnId,
        manifest: binding.manifest,
        state,
        commentWork,
        readAsset: (hash) =>
          binding
            .readAsset(hash)
            .pipe(Effect.mapError(() => new CadRenderError({ reason: "unavailable" }))),
      });
    });
    const list = Effect.fn("CadComments.list")(function* (input: unknown) {
      const request = yield* decode(CadCommentsListInput, input);
      const all = yield* read(threadId);
      const version = all.length;
      const filterHash = digest(
        canonicalCadJson({
          rootId: request.rootId,
          modelKey: request.modelKey,
          state: request.state,
        }),
      );
      let after = 0;
      if (request.cursor) {
        const pieces = request.cursor.split(":");
        if (pieces[0] !== String(version) || pieces[2] !== filterHash)
          return yield* fail("catalog-changed");
        after = Number(pieces[1]);
        if (!Number.isSafeInteger(after) || after < 0) return yield* fail("invalid-cursor");
      }
      const selected = all
        .filter(
          (c) =>
            (!request.rootId || c.rootId === request.rootId) &&
            (!request.modelKey || c.modelKey === request.modelKey) &&
            (!request.state || c.state === request.state),
        )
        .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
      const page = selected.filter((c) => c.number > after).slice(0, request.limit ?? 50);
      const last = page.at(-1);
      return {
        result: {
          comments: page,
          catalogVersion: version,
          nextCursor:
            last && selected.some((c) => c.number > last.number)
              ? `${version}:${last.number}:${filterHash}`
              : null,
        },
      };
    });
    const locate = Effect.fn("CadComments.locate")(function* (input: unknown) {
      const request = yield* decode(CadCommentLocateInput, input);
      const rows =
        yield* sql`SELECT record_json,view_json FROM projection_cad_captures WHERE capture_id=${request.captureId} AND thread_id=${threadId}`;
      if (!rows[0]) return yield* fail("capture-unavailable");
      const record = yield* decode(Schema.fromJsonString(CadCaptureRecord), rows[0].record_json);
      const state = yield* decode(Schema.fromJsonString(CadViewState), rows[0].view_json);
      if (new Set(request.picks.map((p) => p.pickKey)).size !== request.picks.length)
        return yield* fail("duplicate-pick-key");
      const binding = yield* bind(record.capture.snapshotId);
      const rendered = yield* render(binding, state, { kind: "locate", picks: request.picks });
      const results = (rendered.receipt.commentHits ?? []).map((hit) => {
        if (hit.reason !== "candidate" || !hit.point || !hit.occurrenceId) return hit;
        const pick = request.picks.find((p) => p.pickKey === hit.pickKey);
        if (
          !pick ||
          pick.intendedOccurrenceId !== hit.occurrenceId ||
          !binding.manifest.nodes.some((n) => n.id === hit.occurrenceId && n.kind === "part")
        )
          return { ...hit, reason: "invalid-render-result" };
        const id = uuid();
        candidates.set(id, {
          id,
          captureId: request.captureId,
          state,
          binding,
          occurrenceId: hit.occurrenceId,
          point: hit.point,
          normal: hit.normal,
          inspectionIds: new Set(),
        });
        return { ...hit, candidateId: id };
      });
      return { result: { ...CAD_CAPTURE_SIZE, results }, png: rendered.png };
    });
    const inspect = Effect.fn("CadComments.inspect")(function* (input: unknown) {
      const request = yield* decode(CadCommentInspectInput, input);
      if (new Set(request.candidateIds).size !== request.candidateIds.length)
        return yield* fail("duplicate-candidate");
      const selected: Candidate[] = [];
      for (const id of request.candidateIds) {
        const c = candidates.get(id);
        if (!c) return yield* fail("candidate-expired");
        selected.push(c);
      }
      const first = selected[0]!;
      if (selected.some((c) => c.state.snapshotId !== first.state.snapshotId))
        return yield* fail("mixed-revision");
      const rendered = yield* render(first.binding, first.state, {
        kind: "inspect",
        targets: selected.map((c) => ({
          candidateId: c.id,
          occurrenceId: c.occurrenceId,
          point: c.point,
        })),
      });
      const inspectionId = uuid();
      yield* checkOwner;
      const file = path.join(evidenceDirectory, `${inspectionId}.png`);
      evidenceIds.add(inspectionId);
      activeEvidence.add(inspectionId);
      yield* fs.makeDirectory(evidenceDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(evidenceDirectory, `${inspectionId}.json`),
        canonicalCadJson({
          schemaVersion: 1,
          captureConvention: "cad-capture-v1",
          inspectionId,
          threadId,
          turnId,
          snapshotId: first.state.snapshotId,
          sourceViews: selected.map((c) => ({
            candidateId: c.id,
            captureId: c.captureId,
            state: c.state,
            occurrenceId: c.occurrenceId,
            point: c.point,
          })),
          inspectionCamera: rendered.receipt.pose,
          hits: rendered.receipt.commentHits,
        }),
        { flag: "wx" },
      );
      yield* fs.writeFile(file, rendered.png, { flag: "wx" });
      yield* checkOwner.pipe(
        Effect.onError(() =>
          Effect.all([
            fs.remove(file, { force: true }),
            fs.remove(file.replace(/\.png$/, ".json"), { force: true }),
          ]).pipe(Effect.ignore),
        ),
      );
      for (const c of selected)
        if (rendered.receipt.commentHits?.some((h) => h.pickKey === c.id && h.reason === "visible"))
          c.inspectionIds.add(inspectionId);
      return {
        result: {
          inspectionId,
          artifact: { path: file, mimeType: "image/png", ...CAD_CAPTURE_SIZE },
          results: rendered.receipt.commentHits?.map((h, i) => ({ ...h, marker: i + 1 })),
          summary:
            "Verify each yellow marker's surface and depth. Publish verified holes as separate precise comments. Inspect remaining red/occluded candidates individually to choose a better angle; if still uncertain, capture a closer alternate view and locate a reliable rim. A render error is a technical failure: retry inspection before whole-part fallback. Previously verified candidates remain usable during this turn.",
        },
        png: rendered.png,
      };
    });
    const publish = Effect.fn("CadComments.publish")(function* (input: unknown) {
      const request = yield* decode(CadCommentsPublishInput, input);
      const project = yield* owner(threadId);
      const model = yield* query.getCommandReadModel();
      const existing = (model.cadComments ?? []).filter((c) => c.threadId === threadId);
      const comments: CadComment[] = [],
        receipts: CadCommentReceipt[] = [],
        proposals: CadCommentProposed[] = [];
      const results: {
        publicationKey: string;
        commentId?: string;
        reason?: string;
        replayed?: boolean;
        placement?: string;
      }[] = [];
      const seen = new Set<string>();
      // Titles of rejected items, when the agent supplied one, so chat can name what failed.
      const titles = new Map<string, string>();
      // Reused findings already appeared in an earlier turn, so chat does not count them as written.
      const reusedKeys = new Set<string>();
      // Proposals change no comment text; chat lists them apart from written findings.
      const proposedKeys = new Set<string>();
      for (const raw of request.items) {
        const key =
          typeof raw === "object" && raw !== null && "publicationKey" in raw
            ? raw.publicationKey
            : null;
        if (typeof key !== "string") continue;
        if (seen.has(key)) return yield* fail("duplicate-publication-key");
        seen.add(key);
        const title =
          typeof raw === "object" && raw !== null && "title" in raw ? raw.title : undefined;
        if (typeof title === "string" && title.trim()) titles.set(key, title.trim().slice(0, 160));
      }
      for (const raw of request.items) {
        yield* Effect.gen(function* () {
          const item = yield* decode(CadCommentPublication, raw);
          const hash = digest(
            canonicalCadJson(item.kind === "new" ? { ...item, link: item.link ?? null } : item),
          );
          const prior = model.cadCommentReceipts?.find(
            (r) => r.threadId === threadId && r.key === item.publicationKey,
          );
          if (prior) {
            if (prior.hash !== hash) return yield* fail("idempotency-conflict");
            results.push({
              publicationKey: item.publicationKey,
              commentId: prior.commentId,
              replayed: true,
            });
            return;
          }
          if (existing.length !== request.expectedCatalogVersion)
            return yield* fail("catalog-changed");
          const binding = yield* bind(item.inspectedSnapshotId);
          const descriptor = cadCommentModelDescriptor(binding.manifest),
            modelKey = digest(descriptor);
          let commentId: string;
          if (item.kind === "reuse") {
            const old = existing.find(
              (c) =>
                c.id === item.reuseCommentId &&
                c.modelKey === modelKey &&
                c.modelDescriptor === descriptor,
            );
            if (!old) return yield* fail("model-equivalence-unverified");
            commentId = old.id;
            reusedKeys.add(item.publicationKey);
          } else if (item.kind === "propose-resolve") {
            const old = existing.find((c) => c.id === item.commentId);
            if (!old) return yield* fail("comment-unavailable");
            if (old.state !== "open") return yield* fail("comment-not-open");
            // Evidence must come from a later revision of the same root than the finding describes.
            const original = yield* store
              .withPinned(old.snapshotId, (m) => Effect.succeed(m.createdAt))
              .pipe(Effect.mapError(() => fail("snapshot-unavailable")));
            if (
              binding.manifest.rootId !== old.rootId ||
              Date.parse(binding.manifest.createdAt) <= Date.parse(original)
            )
              return yield* fail("snapshot-not-newer");
            commentId = old.id;
            proposals.push({
              commentId,
              proposal: {
                snapshotId: item.inspectedSnapshotId,
                explanation: item.explanation,
                turnId,
                createdAt: DateTime.formatIso(yield* DateTime.now),
              },
            });
            proposedKeys.add(item.publicationKey);
          } else {
            if (
              item.link &&
              !existing.some(
                (c) => c.id === item.link?.commentId && c.rootId === binding.manifest.rootId,
              )
            )
              return yield* fail("invalid-comment-link");
            const targets: CadCommentTarget[] = [];
            for (const target of item.targets) {
              if (target.kind === "part") {
                if (
                  !binding.manifest.nodes.some(
                    (n) =>
                      n.id === target.occurrenceId &&
                      n.kind === "part" &&
                      !n.suppressed &&
                      n.sourcePartKey !== null &&
                      binding.manifest.assets.some((a) => a.geometryKey === n.sourcePartKey),
                  )
                )
                  return yield* fail("occurrence-unavailable");
                targets.push(target);
              } else {
                const c = candidates.get(target.candidateId);
                if (!c) return yield* fail("candidate-expired");
                if (c.state.snapshotId !== item.inspectedSnapshotId)
                  return yield* fail("mixed-revision");
                if (!c.inspectionIds.has(target.inspectionId))
                  return yield* fail("inspection-required");
                targets.push({
                  kind: "point",
                  label: target.label,
                  occurrenceId: c.occurrenceId,
                  point: c.point,
                  normal: c.normal,
                  captureId: c.captureId,
                  inspectionId: target.inspectionId,
                  confirmationReason: target.confirmationReason,
                });
              }
            }
            commentId = uuid();
            comments.push({
              id: commentId,
              threadId,
              rootId: binding.manifest.rootId,
              snapshotId: binding.manifest.snapshotId,
              modelKey,
              modelDescriptor: descriptor,
              title: item.title,
              body: item.body,
              severity: item.severity,
              category: item.category,
              targets,
              link: item.link ?? null,
              state: "open",
              version: 0,
              number: existing.length + comments.length + 1,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              turnId,
              outdated: null,
              proposal: null,
            });
          }
          receipts.push({ threadId, key: item.publicationKey, hash, commentId });
          results.push({
            publicationKey: item.publicationKey,
            commentId,
            replayed: false,
            placement: project.cad?.roots.some(
              (r) => r.current?.snapshotId === item.inspectedSnapshotId,
            )
              ? "currentForRoot"
              : "historicalForRoot",
          });
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              const failure = error(cause);
              results.push({
                publicationKey:
                  typeof raw === "object" && raw !== null && "publicationKey" in raw
                    ? String(raw.publicationKey)
                    : "invalid",
                reason: failure.reason,
                ...(failure.details === undefined ? {} : { details: failure.details }),
              });
            }),
          ),
        );
      }
      if (receipts.length)
        yield* engine
          .dispatch({
            type: "thread.cad.comments.commit",
            commandId: CommandId.make(uuid()),
            threadId,
            expectedCatalogVersion: request.expectedCatalogVersion,
            comments,
            receipts,
            proposals,
          })
          .pipe(
            Effect.uninterruptible,
            Effect.catch((cause) =>
              Effect.sync(() => {
                const failure = error(cause);
                for (const result of results) {
                  if (result.replayed === false) {
                    delete result.commentId;
                    delete result.placement;
                    result.reason = failure.reason;
                  }
                }
              }),
            ),
          );
      const latest = yield* read(threadId);
      const currentProject = yield* owner(threadId);
      const delivered = [];
      for (const result of results) {
        const comment = latest.find((c) => c.id === result.commentId);
        if (!comment) {
          delivered.push(result);
          continue;
        }
        const currentId = currentProject.cad?.roots.find((r) => r.rootId === comment.rootId)
          ?.current?.snapshotId;
        let placement = "historicalForRoot";
        if (currentId) {
          const current = yield* bind(currentId).pipe(Effect.option);
          if (
            Option.isSome(current) &&
            cadCommentModelDescriptor(current.value.manifest) === comment.modelDescriptor
          )
            placement = "currentForRoot";
        }
        const sequence =
          yield* sql`SELECT sequence FROM projection_cad_comments WHERE comment_id=${comment.id}`;
        delivered.push({
          ...result,
          placement,
          state: comment.state,
          reviewVersion: comment.version,
          originalSequence: sequence[0]?.sequence,
        });
      }
      yield* recordPublication(
        results.filter((result) => !reusedKeys.has(result.publicationKey)),
        latest,
        titles,
        proposedKeys,
      );
      return { result: { results: delivered, catalogVersion: latest.length } };
    });
    /** Appends the chat activity for this call. Display only, so failures never fail the tool. */
    const recordPublication = (
      results: ReadonlyArray<{
        publicationKey: string;
        commentId?: string;
        reason?: string;
        replayed?: boolean;
      }>,
      latest: readonly CadComment[],
      titles: ReadonlyMap<string, string>,
      proposedKeys: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        const committed = (result: (typeof results)[number]) =>
          result.replayed === false ? latest.find((c) => c.id === result.commentId) : undefined;
        const card: CadCommentsPublishedCard = {
          published: results.flatMap((result) => {
            const comment = proposedKeys.has(result.publicationKey) ? undefined : committed(result);
            return comment
              ? [
                  {
                    publicationKey: result.publicationKey,
                    commentId: comment.id,
                    number: comment.number,
                    title: comment.title,
                    severity: comment.severity,
                    category: comment.category,
                    location: comment.targets[0]?.label ?? "",
                  },
                ]
              : [];
          }),
          rejected: results.flatMap((result) =>
            result.reason === undefined
              ? []
              : [
                  {
                    publicationKey: result.publicationKey,
                    title: titles.get(result.publicationKey) ?? null,
                    reason: result.reason,
                  },
                ],
          ),
          proposed: results.flatMap((result) => {
            const comment = proposedKeys.has(result.publicationKey) ? committed(result) : undefined;
            return comment
              ? [
                  {
                    publicationKey: result.publicationKey,
                    commentId: comment.id,
                    number: comment.number,
                    title: comment.title,
                  },
                ]
              : [];
          }),
        };
        if (!card.published.length && !card.rejected.length && !card.proposed.length) return;
        const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
        const summary = [
          card.published.length ? `wrote ${count(card.published.length, "comment")}` : "",
          card.proposed.length ? `proposed ${count(card.proposed.length, "resolution")}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        const id = uuid();
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(id),
          threadId,
          activity: {
            id: EventId.make(`cad-comments-${id}`),
            tone: "info",
            kind: CAD_COMMENTS_PUBLISHED_ACTIVITY,
            summary: summary
              ? summary.charAt(0).toUpperCase() + summary.slice(1)
              : "Comments not published",
            payload: card,
            turnId,
            createdAt,
          },
          createdAt,
        });
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("CAD comment chat activity was not recorded", { threadId }),
        ),
      );
    return {
      invoke: (name: string, input: unknown) =>
        Effect.suspend((): Effect.Effect<CadCommentDelivery, CadCommentError> => {
          if (!active) return Effect.fail(fail("candidate-expired"));
          switch (name) {
            case "cad_comments_list":
              return list(input).pipe(Effect.mapError(error));
            case "cad_comment_locate":
              return locate(input).pipe(Effect.mapError(error));
            case "cad_comment_inspect":
              return inspect(input).pipe(Effect.mapError(error));
            case "cad_comments_publish":
              return publish(input).pipe(Effect.mapError(error));
            default:
              return Effect.fail(fail("capability-unavailable"));
          }
        }).pipe(
          Effect.andThen((delivery) => checkOwner.pipe(Effect.as(delivery))),
          Effect.raceFirst(Deferred.await(deleted)),
          Effect.onError(() =>
            checkOwner.pipe(
              Effect.catch(() => cleanupEvidence),
              Effect.ignore,
            ),
          ),
          Effect.mapError(error),
        ),
    };
  }, Effect.mapError(error));
  return CadComments.of({ activate, watch, review, learnings, removeLearning });
});
export const layer = Layer.effect(CadComments, make);
