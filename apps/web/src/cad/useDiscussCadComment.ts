import type { CadComment, ScopedThreadRef } from "@cadsense/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useComposerDraftStore } from "../composerDraftStore";
import { useComposerHandleContext } from "../composerHandleContext";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";

/** Composer text naming a finding the way `cad_comments_list` reports it, so the agent can look it up. */
export function cadCommentDiscussSeed(comment: CadComment): string {
  const location = comment.targets[0]?.label ?? "";
  return `About CAD comment #${comment.number} "${comment.title}" (${location}): `;
}

/**
 * Returns the Discuss action for findings owned by `threadRef`: seeds that
 * chat's composer with a reference to the finding and shows the composer.
 * Another active thread is left for the finding's thread first; its chat
 * focuses the composer when it mounts.
 */
export function useDiscussCadComment(threadRef: ScopedThreadRef) {
  const navigate = useNavigate();
  const composer = useComposerHandleContext();
  const active = useParams({ strict: false, select: (params) => resolveThreadRouteTarget(params) });
  const sameThread =
    active?.kind === "server" &&
    active.threadRef.environmentId === threadRef.environmentId &&
    active.threadRef.threadId === threadRef.threadId;
  return (comment: CadComment) => {
    const snapshot = sameThread ? composer?.current?.readSnapshot() : undefined;
    const cursor = useComposerDraftStore
      .getState()
      .seedPrompt(threadRef, cadCommentDiscussSeed(comment), snapshot?.cursor ?? null);
    if (!sameThread) {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
      return;
    }
    // The editor picks the seeded draft up on its next render; place the caret after it.
    requestAnimationFrame(() => {
      if (cursor === null) composer?.current?.focusAtEnd();
      else composer?.current?.focusAt(cursor);
    });
  };
}
