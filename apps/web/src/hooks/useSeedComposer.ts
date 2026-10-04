import type { ScopedThreadRef } from "@cadsense/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useComposerDraftStore } from "../composerDraftStore";
import { useComposerHandleContext } from "../composerHandleContext";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";

/**
 * Returns a function that seeds `threadRef`'s composer with text and shows the composer, for
 * actions that start a message to the agent. Another active thread is left for that thread first;
 * its chat focuses the composer when it mounts.
 */
export function useSeedComposer(threadRef: ScopedThreadRef) {
  const navigate = useNavigate();
  const composer = useComposerHandleContext();
  const active = useParams({ strict: false, select: (params) => resolveThreadRouteTarget(params) });
  const sameThread =
    active?.kind === "server" &&
    active.threadRef.environmentId === threadRef.environmentId &&
    active.threadRef.threadId === threadRef.threadId;
  return (seed: string) => {
    const snapshot = sameThread ? composer?.current?.readSnapshot() : undefined;
    const cursor = useComposerDraftStore
      .getState()
      .seedPrompt(threadRef, seed, snapshot?.cursor ?? null);
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
