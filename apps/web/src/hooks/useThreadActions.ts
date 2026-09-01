import { scopeProjectRef, scopedThreadKey } from "@cadsense/client-runtime/environment";
import { settlePromise } from "@cadsense/client-runtime/state/runtime";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import { readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";

export class ThreadArchiveBlockedError extends Schema.TaggedErrorClass<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Cannot archive a running thread.";
  }
}

export function useThreadActions() {
  const router = useRouter();
  const archiveThreadMutation = useAtomCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useAtomCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useAtomCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const clearDraftThread = useComposerDraftStore((state) => state.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (state) => state.clearProjectDraftThreadById,
  );
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const handleNewThread = useNewThreadHandler();
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;

  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const archiveThread = useCallback(
    async (target: ScopedThreadRef, opts: { onArchived?: () => void } = {}) => {
      const thread = readThreadShell(target);
      if (!thread) return AsyncResult.success(undefined);
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadArchiveBlockedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }

      const current = getCurrentRouteThreadRef();
      const shouldNavigate =
        current?.environmentId === target.environmentId && current.threadId === target.threadId;
      const result = await archiveThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Failure") return result;

      refreshArchivedThreadsForEnvironment(target.environmentId);
      opts.onArchived?.();
      if (!shouldNavigate) return result;

      const navigation = await settlePromise(() =>
        handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      return navigation._tag === "Failure" ? navigation : result;
    },
    [archiveThreadMutation, getCurrentRouteThreadRef],
  );

  const unarchiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const result = await unarchiveThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success") {
        refreshArchivedThreadsForEnvironment(target.environmentId);
      }
      return result;
    },
    [unarchiveThreadMutation],
  );

  const deleteThread = useCallback(
    async (target: ScopedThreadRef, _opts: { deletedThreadKeys?: ReadonlySet<string> } = {}) => {
      const thread = readThreadShell(target);
      const current = getCurrentRouteThreadRef();
      const shouldNavigate =
        current?.environmentId === target.environmentId && current.threadId === target.threadId;

      if (thread?.session && thread.session.status !== "stopped") {
        await stopThreadSession({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
      }
      const result = await deleteThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Failure") return result;

      refreshArchivedThreadsForEnvironment(target.environmentId);
      releaseComposerDraftUploads(target);
      clearDraftThread(target);
      if (thread) {
        clearProjectDraftThreadById(
          scopeProjectRef(thread.environmentId, thread.projectId),
          target,
        );
      }

      if (shouldNavigate) {
        const navigation = await settlePromise(() => router.navigate({ to: "/", replace: true }));
        if (navigation._tag === "Failure") return navigation;
      }
      return result;
    },
    [
      clearDraftThread,
      clearProjectDraftThreadById,
      deleteThreadMutation,
      getCurrentRouteThreadRef,
      router,
      stopThreadSession,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      if (confirmThreadDelete) {
        const localApi = readLocalApi();
        if (localApi) {
          const title = readThreadShell(target)?.title ?? "this thread";
          const confirmation = await settlePromise(() =>
            localApi.dialogs.confirm(
              [
                `Delete thread "${title}"?`,
                "This permanently clears conversation history for this thread.",
              ].join("\n"),
              { variant: "destructive" },
            ),
          );
          if (confirmation._tag === "Failure") return confirmation;
          if (!confirmation.value) return AsyncResult.success(undefined);
        }
      }
      return deleteThread(target);
    },
    [confirmThreadDelete, deleteThread],
  );

  return useMemo(
    () => ({ archiveThread, unarchiveThread, deleteThread, confirmAndDeleteThread }),
    [archiveThread, confirmAndDeleteThread, deleteThread, unarchiveThread],
  );
}
