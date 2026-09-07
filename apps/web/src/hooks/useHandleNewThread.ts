import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@cadsense/client-runtime/environment";
import { DEFAULT_RUNTIME_MODE, type ScopedProjectRef, type ThreadId } from "@cadsense/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { resolveNewThreadModelSelectionOverride } from "../lib/chatThreadActions";
import { newDraftId, newThreadId } from "../lib/utils";
import { readThreadShell, useProjects, useThread } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { toastManager } from "../components/ui/toast";

interface NewThreadOptions {
  readonly replace?: boolean;
  readonly carryComposerContent?: boolean;
}

export function useNewThreadHandler() {
  const projects = useProjects();
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    async (
      projectRef: ScopedProjectRef,
      options?: NewThreadOptions,
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const store = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft"
          ? store.getDraftSession(currentRouteTarget.draftId)
          : null;
      const carrySourceComposer = currentRouteTarget
        ? store.getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const carryModelSelection =
        (composerActiveProvider
          ? carrySourceComposer?.modelSelectionByProvider[composerActiveProvider]
          : null) ??
        carrySourceShell?.modelSelection ??
        null;
      const carryRuntimeMode = DEFAULT_RUNTIME_MODE;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        undefined;
      const carryContentSourceDraftId =
        options?.carryComposerContent === true && currentRouteTarget?.kind === "draft"
          ? currentRouteTarget.draftId
          : null;

      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = scopedProjectKey(projectRef);

      const storedDraft = store.getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedThreadRef = storedDraft
        ? scopeThreadRef(storedDraft.environmentId, storedDraft.threadId)
        : null;
      const reusableStoredDraft =
        storedDraft !== null &&
        storedDraft.promotedTo == null &&
        storedThreadRef !== null &&
        readThreadShell(storedThreadRef) === null &&
        !composerDraftHasUserContent(store.getComposerDraft(storedDraft.draftId))
          ? storedDraft
          : null;
      if (storedThreadRef !== null && reusableStoredDraft === null) {
        markPromotedDraftThreadByRef(storedThreadRef);
      }

      const draftId = reusableStoredDraft?.draftId ?? newDraftId();
      const threadId = reusableStoredDraft?.threadId ?? newThreadId();
      const createdAt = reusableStoredDraft?.createdAt ?? new Date().toISOString();

      store.setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        runtimeMode: carryRuntimeMode,
        ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
      });
      store.setRuntimeMode(draftId, DEFAULT_RUNTIME_MODE);

      const draft = store.getComposerDraft(draftId);
      const activeSelection = draft?.activeProvider
        ? draft.modelSelectionByProvider[draft.activeProvider]
        : undefined;
      if (!activeSelection || draft?.modelSelectionExplicit !== true) {
        store.applyStickyState(draftId);
        const selection = resolveNewThreadModelSelectionOverride({
          projectDefaultSelection: project?.defaultModelSelection ?? null,
          carrySelection: carryModelSelection,
          carrySourceDraftId:
            currentRouteTarget?.kind === "draft" ? currentRouteTarget.draftId : null,
          destinationDraftId: draftId,
        });
        if (selection) {
          store.setModelSelection(draftId, selection, { replaceOptions: true });
        }
      }

      if (
        carryContentSourceDraftId &&
        carryContentSourceDraftId !== draftId &&
        !composerDraftHasUserContent(store.getComposerDraft(draftId)) &&
        composerDraftHasUserContent(store.getComposerDraft(carryContentSourceDraftId))
      ) {
        store.moveComposerPromptAndImages(carryContentSourceDraftId, draftId);
        const remaining = store.getComposerDraft(carryContentSourceDraftId);
        const remainingCount = (remaining?.files.length ?? 0) + (remaining?.images.length ?? 0);
        if (remainingCount > 0) {
          toastManager.add({
            type: "warning",
            title: `${remainingCount} attachment${remainingCount === 1 ? " stayed" : "s stayed"} in the original draft`,
            description: "Return to the original draft or attach the files again.",
          });
        }
      }

      const routeTarget = getCurrentRouteTarget();
      if (routeTarget?.kind !== "draft" || routeTarget.draftId !== draftId) {
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
      }
      return { draftId, threadId };
    },
    [getCurrentRouteTarget, projects, router],
  );
}

export function useHandleNewThread() {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(
    () => [...projects].sort((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread: useNewThreadHandler(),
    routeThreadRef,
  };
}
