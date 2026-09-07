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
  CadCaptureRecord,
  CadViewState,
  CommandId,
  type CadComment,
  type CadCommentReceipt,
  type CadCommentTarget,
  type CadSnapshotManifest,
  type CadCommentRenderWork,
  type ThreadId,
  type TurnId,
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

const fail = (reason: string) => new CadCommentError({ reason });
const isCommentError = Schema.is(CadCommentError);
const error = (cause: unknown) =>
  isCommentError(cause) ? cause : fail(cause instanceof Error ? cause.message : "unavailable");
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const uuid = () => NodeCrypto.randomUUID();
const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => fail("invalid-input")));
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
    readonly watch: (threadId: ThreadId) => Stream.Stream<readonly CadComment[], CadCommentError>;
    readonly review: (
      input: typeof CadCommentReviewInput.Type,
    ) => Effect.Effect<CadComment, CadCommentError>;
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
  const removeDeletedEvidence = Effect.gen(function* () {
    const model = yield* query.getCommandReadModel();
    for (const thread of model.threads)
      if (
        thread.deletedAt !== null ||
        model.projects.some((p) => p.id === thread.projectId && p.deletedAt !== null)
      )
        yield* fs.remove(path.join(config.stateDir, "cad", "comment-evidence", digest(thread.id)), {
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
  const owner = Effect.fn("CadComments.owner")(function* (threadId: ThreadId) {
    const thread = yield* query.getThreadShellById(threadId);
    if (Option.isNone(thread)) return yield* fail("comment-unavailable");
    const project = yield* query.getProjectShellById(thread.value.projectId);
    if (Option.isNone(project)) return yield* fail("comment-unavailable");
    return project.value;
  });
  const read = Effect.fn("CadComments.read")(function* (threadId: ThreadId) {
    yield* owner(threadId);
    const model = yield* query.getCommandReadModel();
    return (model.cadComments ?? []).filter((c) => c.threadId === threadId);
  });
  const watch = (threadId: ThreadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        return Stream.concat(
          Stream.fromEffect(read(threadId)),
          Stream.fromSubscription(events).pipe(
            Stream.filter((e) => e.aggregateId === threadId || e.type === "project.deleted"),
            Stream.mapEffect(() => read(threadId)),
          ),
        );
      }),
    ).pipe(Stream.mapError(error));
  const review = Effect.fn("CadComments.review")(function* (
    input: typeof CadCommentReviewInput.Type,
  ) {
    yield* owner(input.threadId);
    const model = yield* query.getCommandReadModel();
    const hash = digest(
      canonicalCadJson({
        commentId: input.commentId,
        expectedVersion: input.expectedVersion,
        state: input.state,
      }),
    );
    const prior = model.cadCommentReviews?.find((r) => r.commandId === input.commandId);
    if (prior && (prior.threadId !== input.threadId || prior.payloadHash !== hash))
      return yield* fail("idempotency-conflict");
    if (!prior)
      yield* engine.dispatch({ ...input, type: "thread.cad.comment.review", payloadHash: hash });
    const result = (yield* read(input.threadId)).find((c) => c.id === input.commentId);
    if (!result) return yield* fail("comment-unavailable");
    return result;
  }, Effect.mapError(error));

  const activate = Effect.fn("CadComments.activate")(function* (
    threadId: ThreadId,
    contextId: string,
    turnId: TurnId,
  ) {
    yield* owner(threadId);
    const scope = yield* Scope.Scope;
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
      inspectionId?: string;
    };
    const candidates = new Map<string, Candidate>();
    const evidenceDirectory = path.join(
      config.stateDir,
      "cad",
      "comment-evidence",
      digest(threadId),
    );
    const evidenceIds = new Set<string>();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
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
      ),
    );
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
        });
        return { ...hit, candidateId: id };
      });
      return { result: { width: 1280, height: 960, results }, png: rendered.png };
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
      const file = path.join(evidenceDirectory, `${inspectionId}.png`);
      evidenceIds.add(inspectionId);
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
      for (const c of selected)
        if (rendered.receipt.commentHits?.some((h) => h.pickKey === c.id && h.reason === "visible"))
          c.inspectionId = inspectionId;
      return {
        result: {
          inspectionId,
          artifact: { path: file, mimeType: "image/png", width: 1280, height: 960 },
          results: rendered.receipt.commentHits?.map((h, i) => ({ ...h, marker: i + 1 })),
          summary:
            "Yellow markers are visible candidate surfaces; red markers are occluded and cannot be confirmed. Verify the location, not just the part identity.",
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
        receipts: CadCommentReceipt[] = [];
      const results: {
        publicationKey: string;
        commentId?: string;
        reason?: string;
        replayed?: boolean;
        placement?: string;
      }[] = [];
      const seen = new Set<string>();
      for (const raw of request.items) {
        const key =
          typeof raw === "object" && raw !== null && "publicationKey" in raw
            ? raw.publicationKey
            : null;
        if (typeof key !== "string") continue;
        if (seen.has(key)) return yield* fail("duplicate-publication-key");
        seen.add(key);
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
                    (n) => n.id === target.occurrenceId && n.kind === "part",
                  )
                )
                  return yield* fail("occurrence-unavailable");
                targets.push(target);
              } else {
                const c = candidates.get(target.candidateId);
                if (!c) return yield* fail("candidate-expired");
                if (c.state.snapshotId !== item.inspectedSnapshotId)
                  return yield* fail("mixed-revision");
                if (c.inspectionId !== target.inspectionId)
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
              targets,
              link: item.link ?? null,
              state: "open",
              version: 0,
              number: existing.length + comments.length + 1,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              turnId,
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
              results.push({
                publicationKey:
                  typeof raw === "object" && raw !== null && "publicationKey" in raw
                    ? String(raw.publicationKey)
                    : "invalid",
                reason: error(cause).reason,
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
          })
          .pipe(Effect.uninterruptible);
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
      return { result: { results: delivered, catalogVersion: latest.length } };
    });
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
        }).pipe(Effect.mapError(error)),
    };
  }, Effect.mapError(error));
  return CadComments.of({ activate, watch, review });
});
export const layer = Layer.effect(CadComments, make);
