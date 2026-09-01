import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@cadsense/contracts";
import { useCallback } from "react";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
} from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { readLocalApi } from "../localApi";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
}) {
  const { threadRef, projectCwd, onStartRename } = input;
  const { archiveThread, deleteThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const pinThread = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinThread = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) =>
      toastManager.add({ type: "success", title: "Path copied", description: path }),
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) =>
      toastManager.add({ type: "success", title: "Thread ID copied", description: threadId }),
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const thread = readThreadShell(threadRef);
        if (!thread) return;

        const isRegeneratingTitle = thread.titleRegeneration != null;
        const items = buildThreadActionMenuItems({
          isRegeneratingTitle,
          isRunning: thread.session?.status === "running" && thread.session.activeTurnId != null,
          isPinned: thread.pinnedAt != null,
          supportsPinning: readEnvironmentSupportsPinning(threadRef.environmentId),
          supportsTitleRegeneration: readEnvironmentSupportsTitleRegeneration(
            threadRef.environmentId,
          ),
        });
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadActionMenuId = clicked.value;
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title, squashAtomCommandFailure(result));
          }
        };

        switch (action) {
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure("Failed to regenerate thread title", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "copy-path":
            if (!projectCwd) {
              failureToast("Path unavailable", "This thread does not have a workspace path.");
              return;
            }
            copyPathToClipboard(projectCwd, { path: projectCwd });
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "pin":
            await reportFailure("Failed to pin thread", () =>
              pinThread({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId },
              }),
            );
            return;
          case "unpin": {
            if (confirmThreadUnpin) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Unpin thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            await reportFailure("Failed to unpin thread", () =>
              unpinThread({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId },
              }),
            );
            return;
          }
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            await reportFailure("Failed to archive thread", () => archiveThread(threadRef));
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            await reportFailure("Failed to delete thread", () => deleteThread(threadRef));
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      confirmThreadUnpin,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      onStartRename,
      projectCwd,
      pinThread,
      threadRef,
      updateThreadMetadata,
      unpinThread,
    ],
  );

  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu };
}
