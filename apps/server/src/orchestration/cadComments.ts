import type {
  CadCommentOutdated,
  OrchestrationCommand,
  OrchestrationReadModel,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { requireThread, requireActiveProject } from "./commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
export const decideCadComments = Effect.fn("decideCadComments")(function* (
  command: Extract<
    OrchestrationCommand,
    {
      type:
        | "thread.cad.comments.commit"
        | "thread.cad.comment.review"
        | "thread.cad.comments.outdate";
    }
  >,
  model: OrchestrationReadModel,
) {
  const thread = yield* requireThread({ readModel: model, command, threadId: command.threadId });
  const project = yield* requireActiveProject({
    readModel: model,
    command,
    projectId: thread.projectId,
  });
  const fail = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  if (thread.deletedAt !== null) return yield* fail("comment-unavailable");
  const comments = (model.cadComments ?? []).filter((c) => c.threadId === thread.id);
  if (command.type === "thread.cad.comment.review") {
    const comment = comments.find((c) => c.id === command.commentId);
    if (!comment) return yield* fail("comment-unavailable");
    if (comment.version !== command.expectedVersion) return yield* fail("review-version-conflict");
    return {
      type: "thread.cad-comment-reviewed" as const,
      payload: {
        threadId: thread.id,
        commentId: comment.id,
        state: command.state,
        version: comment.version + 1,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
        commandId: command.commandId,
        payloadHash: command.payloadHash,
      },
    };
  }
  if (command.type === "thread.cad.comments.outdate") {
    // Annotations only ever describe the snapshot that is current for the comment's root.
    const root = project.cad?.roots.find((r) => r.current?.snapshotId === command.snapshotId);
    if (!root) return yield* fail("snapshot-not-current");
    const entries: { commentId: string; outdated: CadCommentOutdated | null }[] = [];
    for (const entry of command.entries) {
      const comment = comments.find((c) => c.id === entry.commentId);
      if (!comment || comment.state !== "open" || comment.rootId !== root.rootId)
        return yield* fail("comment-unavailable");
      if (entry.reason === null) {
        if (comment.outdated !== null) entries.push({ commentId: comment.id, outdated: null });
      } else if (comment.outdated?.reason !== entry.reason)
        entries.push({
          commentId: comment.id,
          outdated: { snapshotId: command.snapshotId, reason: entry.reason },
        });
    }
    if (entries.length === 0) return yield* fail("outdated-unchanged");
    return {
      type: "thread.cad-comments-outdated" as const,
      payload: { threadId: thread.id, snapshotId: command.snapshotId, entries },
    };
  }
  if (comments.length !== command.expectedCatalogVersion) return yield* fail("catalog-changed");
  const ids = new Set((model.cadComments ?? []).map((c) => c.id));
  const keys = new Set(
    (model.cadCommentReceipts ?? []).filter((r) => r.threadId === thread.id).map((r) => r.key),
  );
  for (const c of command.comments) {
    if (c.threadId !== thread.id || c.state !== "open" || c.version !== 0 || ids.has(c.id))
      return yield* fail("invalid-comment");
    if (c.link && !comments.some((old) => old.id === c.link?.commentId && old.rootId === c.rootId))
      return yield* fail("invalid-comment-link");
    ids.add(c.id);
  }
  for (const p of command.proposals) {
    const comment = comments.find((c) => c.id === p.commentId);
    if (!comment || comment.state !== "open") return yield* fail("comment-not-open");
  }
  for (const r of command.receipts) {
    if (
      r.threadId !== thread.id ||
      keys.has(r.key) ||
      (!comments.some((c) => c.id === r.commentId) &&
        !command.comments.some((c) => c.id === r.commentId))
    )
      return yield* fail("idempotency-conflict");
    keys.add(r.key);
  }
  return {
    type: "thread.cad-comments-committed" as const,
    payload: {
      threadId: thread.id,
      comments: command.comments,
      receipts: command.receipts,
      proposals: command.proposals,
    },
  };
});
