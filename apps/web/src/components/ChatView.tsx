import {
  type ApprovalRequestId,
  type ChatFileAttachment,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderApprovalDecision,
  type PreviewAnnotationPayload,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  RuntimeMode,
} from "@cadsense/contracts";
import {
  connectionStatusTitle,
  type EnvironmentConnectionPresentation,
} from "@cadsense/client-runtime/connection";
import { wasBootstrapThreadDeleted } from "@cadsense/client-runtime/errors";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@cadsense/client-runtime/state/threads";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@cadsense/client-runtime/environment";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@cadsense/shared/model";
import { CHAT_LIST_ANCHOR_OFFSET } from "@cadsense/shared/chatList";
import { truncate } from "@cadsense/shared/String";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cadsense/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { collapseExpandedComposerCursor, type ComposerSubmissionIntent } from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  deriveTurnPlans,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { getAnchoredTurnMetrics, type TimelineScrollMode } from "./chat/timelineScrollAnchoring";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { latestWorkspaceMutationId } from "../hooks/useWorkspaceMutationRefresh";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  isImageAttachment,
  videoMimeType,
  type SessionPhase,
  type Thread,
} from "../types";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { RightPanelTabs } from "./RightPanelTabs";
import { AgentsPanel } from "./AgentsPanel";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@cadsense/client-runtime/state/subagentRuntime";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { ChevronDownIcon, Minimize2Icon, PaperclipIcon, WifiOffIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { useBrowserHistoryStore } from "~/browserHistoryStore";
import { registerFaviconProjectForThread } from "~/browserFaviconStore";
import { getProviderModelCapabilities, resolveSelectableProvider } from "../providerModels";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
} from "../providerInstances";
import { useClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  appendElementContextsToPrompt,
  type ElementContextDraft,
  formatElementContextLabel,
} from "../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../lib/previewAnnotation";
import { environmentCatalog } from "../connection/catalog";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import {
  environmentServerConfigsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../state/server";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@cadsense/client-runtime/state/threads";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { useProject, useThread, useThreadRefs, useThreadShell } from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { resolveTimelineIsAtEnd } from "./chat/MessagesTimeline.logic";
import { ChatHeader } from "./chat/ChatHeader";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./chat/PanelLayoutControls";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./chat/ThreadErrorBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  hasAvailableClaudeCompactionProvider,
  hasDismissedResumeCompaction,
  shouldOfferResumeCompaction,
} from "./chat/ContextWindowMeter.logic";
import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "../lib/contextWindow";
import { ThreadSyncStatusPill } from "./chat/ThreadSyncStatusPill";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_DURATION_MS,
  DRAFT_HERO_TRANSITION_EASING,
} from "./chat/draftHeroTransition";
import {
  buildLocalDraftThread,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasEnvironmentReconnectWarningGraceElapsed,
  scheduleEnvironmentReconnectWarning,
  hasServerAcknowledgedLocalDispatch,
  shouldDockDraftHeroForSubmission,
  shouldReleaseTimelineAnchorForToolActivity,
  shoulderTabReserve,
  shouldShowPlanFollowUpPrompt,
  getStartedThreadModelChangeBlockReason,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  readFileAsDataUrl,
  loadVideoPreviewUrl,
  isVideoPreviewRequestCurrent,
  resolveDraftHeroState,
  resolveThreadMetadataUpdateForNextTurn,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  startNewThreadForProject,
  waitForStartedServerThread,
} from "./ChatView.logic";
import type { ThreadSyncPhase } from "../threadSync";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { usePanelPresence } from "~/hooks/usePanelPresence";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { clampFileAttachmentUploadBytes } from "@cadsense/client-runtime/state/attachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./chat/composerAttachmentFiles";
import { assetEnvironment } from "../state/assets";
import { readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { resolveAssetUrl, useAssetUrls } from "../assets/assetUrls";

const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
function useDraftHeroLayoutTransition(isDraftHeroState: boolean) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const attachTransitionGroupRef = (element: HTMLDivElement | null) => {
    transitionGroupRef.current = element;
  };
  const attachComposerAnchorRef = (element: HTMLDivElement | null) => {
    composerAnchorRef.current = element;
  };
  const captureComposerRect = () => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  };

  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    animationRef.current?.cancel();
    animationRef.current = null;

    const previousComposerRect = previousComposerRectRef.current;
    if (
      stateChanged &&
      !prefersReducedMotion &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: DRAFT_HERO_TRANSITION_DURATION_MS,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current !== animation) {
              return;
            }
            animationRef.current = null;
          });
      }
    }

    previousStateRef.current = isDraftHeroState;
    previousComposerRectRef.current = nextComposerRect;
  }, [isDraftHeroState]);

  return [attachTransitionGroupRef, attachComposerAnchorRef, captureComposerRect] as const;
}
const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));
const CadPanel = lazy(() =>
  import("../cad/CadPanel").then((module) => ({ default: module.CadPanel })),
);
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;

  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;

  // The right-panel surface launcher claims its shortcut letters while it is
  // visible (data attribute set in RightPanelTabs); those keys open surfaces
  // instead of typing into the composer.
  const launcherKeys = document
    .querySelector("[data-surface-launcher-keys]")
    ?.getAttribute("data-surface-launcher-keys");
  if (launcherKeys && launcherKeys.toLowerCase().includes(event.key.toLowerCase())) return false;

  return true;
}

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      reserveTitleBarControlInset?: boolean;
      threadSyncPhase?: ThreadSyncPhase | null;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      reserveTitleBarControlInset?: boolean;
      threadSyncPhase?: never;
      routeKind: "draft";
      draftId: DraftId;
    };

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const latestUserMessage = input.activeThread?.messages.findLast(
    (message) => message.role === "user",
  );
  const latestUserMessageId = latestUserMessage?.id ?? null;

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        latestUserMessageId,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      latestUserMessageId,
      localDispatch,
    ],
  );
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const beginLocalDispatch = useCallback(
    (options?: { submissionIntent?: ComposerSubmissionIntent }) => {
      setLocalDispatch((current) => {
        const active = serverAcknowledgedLocalDispatch ? null : current;
        if (active) {
          const submissionIntent = options?.submissionIntent ?? active.submissionIntent;
          return active.submissionIntent === submissionIntent
            ? active
            : { ...active, submissionIntent };
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [input.activeThread, serverAcknowledgedLocalDispatch],
  );

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    latestUserMessageAt: latestUserMessage?.createdAt ?? null,
    isSendBusy: activeLocalDispatch !== null,
    backgroundSubmissionPending: localDispatch?.submissionIntent === "background",
  };
}

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Drops the send-time anchored end space. That space is what holds a sent
 * message near the top while its turn streams, and it keeps LegendList's
 * maintainScrollAtEnd switched off for as long as it is installed — ChatView
 * drives the streaming scrolls itself, but only in "anchoring-new-turn" mode.
 * So every return to the live edge has to release the anchor too, otherwise the
 * timeline settles into "following-end" with nothing following anything.
 */
function releaseChatTimelineAnchor<T extends { readonly messageId: MessageId | null }>(
  current: T,
): T {
  return current.messageId === null ? current : { ...current, messageId: null };
}

function ChatViewContent(props: ChatViewProps) {
  const { environmentId, threadId, routeKind, reserveTitleBarControlInset = true } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const threadSyncPhase = routeKind === "server" ? (props.threadSyncPhase ?? null) : null;
  const threadDetailLoading = threadSyncPhase === "loading";
  const handleNewThread = useNewThreadHandler();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const routeServerThreadShell = useThreadShell(routeKind === "server" ? routeThreadRef : null);
  const serverThread = useThread(routeThreadRef, { waitForShell: draftThread !== null });
  const loadingServerThread = useMemo(
    () =>
      threadDetailLoading && routeServerThreadShell
        ? buildLoadingThreadFromShell(routeServerThreadShell)
        : null,
    [routeServerThreadShell, threadDetailLoading],
  );
  const activeServerThread = serverThread ?? loadingServerThread;
  // Pagination window state for the routed server thread: drives the
  // "load earlier turns" header when the loaded window has older history.
  const routeThreadState = useEnvironmentThread(
    routeKind === "server" ? routeThreadRef.environmentId : null,
    routeKind === "server" ? routeThreadRef.threadId : null,
  );
  const loadEarlierTurns = useMemo(() => {
    if (routeKind !== "server" || !threadHasOlderTurns(routeThreadState)) {
      return null;
    }
    return {
      loading: routeThreadState.page._tag === "Some" && routeThreadState.page.value.loadingOlder,
      onLoadEarlier: () => {
        requestOlderThreadTurns(routeThreadRef.environmentId, routeThreadRef.threadId);
      },
    };
  }, [routeKind, routeThreadRef, routeThreadState]);
  const settings = useEnvironmentSettings(environmentId);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const navigate = useNavigate();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const composerHasUnsentContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(composerDraftTarget)),
  );
  const composerHasAttachments = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0;
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const setComposerDraftElementContexts = useComposerDraftStore(
    (store) => store.setElementContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;
  const videoPreviewRequestIdRef = useRef(0);
  const videoPreviewAbortControllerRef = useRef<AbortController | null>(null);
  const cancelVideoPreviewRequest = useCallback(() => {
    videoPreviewRequestIdRef.current += 1;
    videoPreviewAbortControllerRef.current?.abort();
    videoPreviewAbortControllerRef.current = null;
  }, []);
  const [openingVideoAttachmentId, setOpeningVideoAttachmentId] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  useEffect(() => {
    const item = expandedImage?.images[expandedImage.index];
    if (item?.type !== "video" || !item.src.startsWith("blob:")) return;
    return () => revokeBlobPreviewUrl(item.src);
  }, [expandedImage]);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions = useMemo(
    () => feedbackSubmissionsByThreadKey[routeThreadKey] ?? [],
    [feedbackSubmissionsByThreadKey, routeThreadKey],
  );
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);

  useEffect(() => {
    setIsWorkspaceFileDragActive(false);
  }, [draftId, routeThreadKey]);

  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const shouldUseRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const legendListRef = useRef<LegendListRef | null>(null);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());
  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = activeServerThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!activeServerThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [activeServerThread, draftId, localDraftErrorsByDraftId, routeThreadKey]);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, threadId],
  );
  // Promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  const isServerThread = activeServerThread !== null;
  const activeThread = activeServerThread ?? localDraftThread;
  const threadError = isServerThread
    ? (localServerError ?? activeServerThread?.session?.lastError ?? null)
    : localDraftError;
  // Dismissals can only mask the shown error, never clear it: a server thread
  // keeps its error in session.lastError, so clearing the local shadow would
  // just fall through to the persisted one. Mask the current error until a
  // different error arrives, mirroring the provider status banner.
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError);
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null;
  // Dismissing only mutates the session-scoped mask set, which does not
  // trigger a render on its own; setThreadError(null) can also bail when the
  // local shadow is already empty and the banner is driven purely by
  // session.lastError. Bump a tick so the banner hides immediately.
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  // The app always dispatches in the normal interaction mode. Persisting this
  // on the next turn also releases threads stored in the removed plan mode.
  const interactionMode = DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadEnvironmentId = activeThread?.environmentId ?? null;
  const activeThreadRef = useMemo(
    () =>
      activeThreadEnvironmentId && activeThreadId
        ? scopeThreadRef(activeThreadEnvironmentId, activeThreadId)
        : null,
    [activeThreadEnvironmentId, activeThreadId],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const displayedRightPanelSurface =
    rightPanelState.surfaces.find((surface) => surface.id === rightPanelState.activeSurfaceId) ??
    null;
  const activeFileSurface =
    activeRightPanelSurface?.kind === "file" ? activeRightPanelSurface : null;
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const resolvePreviewRuntimeTabId = useMemo(
    () =>
      activeThreadRef
        ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
        : undefined,
    [activeThreadRef, activePreviewServerEpoch],
  );
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && isPreviewSupportedInRuntime();
  const rightPanelOpen = rightPanelState.isOpen;
  const rightPanelPresence = usePanelPresence(rightPanelOpen);
  useEffect(() => {
    if (!rightPanelPresence.present) {
      setMaximizedRightPanelThreadKey((key) => (key === routeThreadKey ? null : key));
    }
  }, [rightPanelPresence.present, routeThreadKey]);
  const canMaximizeRightPanel = rightPanelOpen && !shouldUseRightPanelSheet;
  const rightPanelMaximized =
    rightPanelPresence.present &&
    !shouldUseRightPanelSheet &&
    maximizedRightPanelThreadKey === routeThreadKey;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUseRightPanelSheet;

  useEffect(() => {
    if (!activeThreadRef) return;
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(activeThreadRef, Object.keys(activePreviewState.sessions));
  }, [activePreviewState.sessions, activeThreadRef]);

  useEffect(() => {
    if (!activeThreadRef || !activePreviewMiniPlayer) return;
    const miniTabStillExists = Boolean(activePreviewState.sessions[activePreviewMiniPlayer.tabId]);
    const sameTabOpenInPanel =
      previewPanelOpen &&
      activeRightPanelSurface?.kind === "preview" &&
      activeRightPanelSurface.resourceId === activePreviewMiniPlayer.tabId;
    if (!miniTabStillExists || sameTabOpenInPanel) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [
    activePreviewMiniPlayer,
    activePreviewState.sessions,
    activeRightPanelSurface,
    activeThreadRef,
    previewPanelOpen,
  ]);

  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeRunningTurnId =
    (activeThread?.session?.status === "running" ? activeThread.session.activeTurnId : null) ??
    (activeLatestTurn?.state === "running" ? activeLatestTurn.turnId : null);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = useMemo(
    () =>
      activeThread ? scopeProjectRef(activeThread.environmentId, activeThread.projectId) : null,
    [activeThread?.environmentId, activeThread?.projectId],
  );
  const activeProject = useProject(activeProjectRef);
  const handleNewThreadInActiveProject = useCallback(() => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  }, [activeProjectRef, handleNewThread]);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = `file:${relativePath}`;
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeProjectKey],
  );
  const configuredPreviewUrls = useMemo<ReadonlyArray<string>>(() => [], []);

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  useEffect(() => {
    if (!activeThreadRef || !activeProjectRef) return;
    registerFaviconProjectForThread(activeThreadRef, activeProjectRef);
  }, [activeProjectRef, activeThreadRef]);
  useEffect(() => {
    if (!activeThreadRef || !activeProjectRef) return;
    useBrowserHistoryStore
      .getState()
      .registerThreadProject(activeThreadRef, scopedProjectKey(activeProjectRef));
  }, [activeProjectRef, activeThreadRef]);
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  );
  useEffect(() => {
    setReconnectWarningGraceElapsedEnvironmentId(null);
    if (activeReconnectingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
    );
  }, [activeReconnectingEnvironmentId]);
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
  });
  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsAttachmentUploads =
    attachmentEnvironmentConfig?.environment.capabilities.attachmentUploads === true;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    const suppressUnavailableBanner = environmentReconnecting && !reconnectWarningGraceElapsed;
    if (activeEnvironmentUnavailableState && unavailableConnection && !suppressUnavailableBanner) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: unavailableConnection.phase === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentUnavailableState.label}: ${connectionStatusTitle(unavailableConnection)}`,
        description:
          unavailableConnection.error ??
          "Reconnect this environment before sending messages or running actions.",
        actions: (
          <Button
            size="xs"
            disabled={environmentReconnecting}
            onClick={() =>
              void handleReconnectActiveEnvironment(activeEnvironmentUnavailableState.environmentId)
            }
          >
            {environmentReconnecting ? "Reconnecting..." : "Reconnect"}
          </Button>
        ),
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    reconnectWarningGraceElapsed,
    handleReconnectActiveEnvironment,
  ]);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider,
  );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workspaceMutationId = useMemo(
    () => latestWorkspaceMutationId(threadActivities),
    [threadActivities],
  );
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(threadActivities),
    [threadActivities],
  );
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities]);
  const turnPlans = useMemo(() => deriveTurnPlans(threadActivities), [threadActivities]);
  // Native subagent fold: memoized by activity-list identity, shared by the
  // Agents surface, live strip, and workflow cards. v2Projection is null
  // until orchestration-v2 lands (source precedence lives in the derive).
  // sessionLive derives interruption for agents orphaned by session death.
  const agentSessionLive = phase !== "disconnected";
  const agentPanelModel = useMemo(
    () =>
      deriveAgentPanelModel({
        agents: foldSubagentActivities(threadActivities, { sessionLive: agentSessionLive }),
      }),
    [agentSessionLive, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  // Current step for the in-chat working row: only for the running turn's own
  // plan (deriveActivePlanState falls back to older turns' plans, which must
  // not label fresh work). Falls back to the first pending step so an
  // all-pending freshly written plan labels the row, matching the chip and
  // the server's planProgress.
  const workingStepLabel = useMemo(() => {
    if (!activePlan || activePlan.turnId !== (activeLatestTurn?.turnId ?? null)) {
      return null;
    }
    return (
      activePlan.steps.find((step) => step.status === "inProgress")?.step ??
      activePlan.steps.find((step) => step.status === "pending")?.step ??
      null
    );
  }, [activeLatestTurn?.turnId, activePlan]);
  const showPlanFollowUpPrompt = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode,
    latestTurnSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
    hasComposerAttachments: composerHasAttachments,
  });
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    latestUserMessageAt,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const isWorking = phase === "running" || isSendBusy || isConnecting;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
    latestUserMessageAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      cancelVideoPreviewRequest();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [cancelVideoPreviewRequest, clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const openFileAttachment = useCallback(
    async (attachment: ChatFileAttachment) => {
      const connection = readPreparedConnection(environmentId);
      if (!connection) {
        toastManager.add({ type: "error", title: "The environment is not connected." });
        return;
      }
      const videoMime = videoMimeType(attachment);
      const isVideo = videoMime !== null;
      const action = isVideo ? "play" : "download";
      const videoPreviewAbortController = isVideo ? new AbortController() : null;
      if (isVideo) {
        videoPreviewAbortControllerRef.current?.abort();
        videoPreviewAbortControllerRef.current = videoPreviewAbortController;
      }
      const videoPreviewRequestId = isVideo ? ++videoPreviewRequestIdRef.current : 0;
      const isCurrentRequest = () =>
        !isVideo ||
        isVideoPreviewRequestCurrent(
          routeThreadKey,
          routeThreadKeyRef.current,
          videoPreviewRequestId,
          videoPreviewRequestIdRef.current,
        );
      const finishVideoPreviewRequest = () => {
        if (videoPreviewRequestIdRef.current === videoPreviewRequestId) {
          setOpeningVideoAttachmentId(null);
          videoPreviewAbortControllerRef.current = null;
        }
      };
      if (isVideo) setOpeningVideoAttachmentId(attachment.id);

      // fileName and mimeType ride in the signed claims so videos render
      // inline while other files keep their real download name and type.
      const result = await createAttachmentAssetUrl({
        environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: videoMime ?? attachment.mimeType,
          },
        },
      });
      if (!isCurrentRequest()) {
        finishVideoPreviewRequest();
        return;
      }
      if (result._tag === "Failure") {
        finishVideoPreviewRequest();
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not " + action + " " + attachment.name,
          description: error instanceof Error ? error.message : "The attachment is unavailable.",
        });
        return;
      }

      const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
      if (!url) {
        finishVideoPreviewRequest();
        toastManager.add({ type: "error", title: "Could not " + action + " " + attachment.name });
        return;
      }
      if (isVideo) {
        try {
          const previewUrl = await loadVideoPreviewUrl(url, videoPreviewAbortController?.signal);
          if (!isCurrentRequest()) {
            revokeBlobPreviewUrl(previewUrl);
            return;
          }
          setExpandedImage({
            images: [{ src: previewUrl, name: attachment.name, type: "video" }],
            index: 0,
          });
        } catch (error) {
          if (!isCurrentRequest()) return;
          toastManager.add({
            type: "error",
            title: "Could not play " + attachment.name,
            description: error instanceof Error ? error.message : "The attachment is unavailable.",
          });
        } finally {
          finishVideoPreviewRequest();
        }
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
    },
    [createAttachmentAssetUrl, environmentId, routeThreadKey],
  );
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages ?? []) {
      for (const attachment of message.attachments ?? []) {
        if (isImageAttachment(attachment)) {
          attachmentIds.add(attachment.id);
        }
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() => {
    if (!serverMessages) return [];
    return serverMessages.map((message) => {
      if (!message.attachments || message.attachments.length === 0) {
        return message;
      }
      return {
        ...message,
        attachments: message.attachments.map((attachment) => {
          const previewUrl = serverAttachmentUrlById.get(attachment.id);
          return previewUrl ? { ...attachment, previewUrl } : attachment;
        }),
      };
    });
  }, [serverAttachmentUrlById, serverMessages]);
  useEffect(() => {
    if (typeof Image === "undefined" || displayServerMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === "user")
        .map((message) => [String(message.id), message] as const),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        isImageAttachment(attachment) && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages]);
  const timelineMessages = useMemo(() => {
    const messages = displayServerMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (!isImageAttachment(attachment)) {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    const localMessages = [
      ...optimisticUserMessages,
      ...feedbackSubmissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
    ];
    if (localMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = localMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    attachmentPreviewHandoffByMessageId,
    displayServerMessages,
    feedbackSubmissions,
    optimisticUserMessages,
  ]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
        turnPlans,
      ),
    [activeThread?.proposedPlans, timelineMessages, turnPlans, workLogEntries],
  );
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread,
    hasTimelineEntries: timelineEntries.length > 0,
    isWorking,
    draftHeroDockRequested,
    backgroundSubmissionPending,
  });
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(isDraftHeroState);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const selectedProviderInstanceId =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)
      ?.instanceId ?? null;
  const activeProviderInstanceId =
    selectedProviderInstanceId ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const compactionProviderAvailable = useMemo(
    () =>
      hasAvailableClaudeCompactionProvider({
        providers: applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providerStatuses),
          settings,
        ),
        instanceId: activeProviderInstanceId,
        lockedInstanceId: lockedProvider
          ? (activeThread?.session?.providerInstanceId ??
            activeThread?.modelSelection.instanceId ??
            null)
          : null,
      }),
    [
      activeProviderInstanceId,
      activeThread?.modelSelection.instanceId,
      activeThread?.session?.providerInstanceId,
      lockedProvider,
      providerStatuses,
      settings,
    ],
  );
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `cadsense:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = useMemo(
    () => hasDismissedResumeCompaction(threadActivities),
    [threadActivities],
  );
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(visibleThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeWorkspaceRoot = activeProjectCwd ?? undefined;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        shouldWriteThreadErrorToCurrentServerThread({
          activeServerThread,
          routeThreadRef,
          targetThreadId,
        })
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [activeServerThread, draftId, routeThreadKey, routeThreadRef],
  );

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const createBrowserSurface = useCallback(() => {
    if (!activeThreadRef) return;
    void addBrowserSurface({ threadRef: activeThreadRef, openPreview });
  }, [activeThreadRef, openPreview]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeProject, activeThreadRef]);
  const addAgentsSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "agents");
  }, [activeThreadRef]);
  const cadAvailable = !!activeProject?.onshapeSource && activeProject.cad?.enabled !== false;
  const cadOpeningRef = useRef(false);
  const [cadOpening, setCadOpening] = useState(false);
  const addCadSurface = useCallback(() => {
    if (
      !activeThreadRef ||
      !activeThread ||
      !activeProject ||
      !cadAvailable ||
      cadOpeningRef.current ||
      sendInFlightRef.current ||
      isSendBusy
    )
      return;
    if (isServerThread) {
      useRightPanelStore.getState().open(activeThreadRef, "cad");
      return;
    }
    cadOpeningRef.current = true;
    setCadOpening(true);
    void createThread({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadRef.threadId,
        projectId: activeProject.id,
        title: activeThread.title,
        modelSelection: activeThread.modelSelection,
        runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    })
      .then((result) => {
        if (result._tag === "Success") {
          markPromotedDraftThreadByRef(activeThreadRef);
          useRightPanelStore.getState().open(activeThreadRef, "cad");
        } else if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not open CAD",
              description: "The thread could not be created. Your draft is preserved.",
            }),
          );
        }
      })
      .finally(() => {
        cadOpeningRef.current = false;
        setCadOpening(false);
      });
  }, [
    activeThreadRef,
    activeThread,
    activeProject,
    cadAvailable,
    isServerThread,
    createThread,
    runtimeMode,
    isSendBusy,
  ]);
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadRef || !activeProject) return;
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
    },
    [activeProject, activeThreadRef],
  );
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      useRightPanelStore.getState().close(activeThreadRef);
      return;
    }
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [activePreviewState.activeTabId, activeThreadRef, createBrowserSurface, previewPanelOpen]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadRef) {
      useRightPanelStore.getState().close(activeThreadRef);
    }
  }, [activeThreadRef]);
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
    },
    [activeThreadRef],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePreviewPanel, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey]);
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
      }
    },
    [activeThreadRef, activePreviewState.sessions, closePreview],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces([surface]);
      useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeOtherSurfaces(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeSurfacesToRight(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    cleanupRightPanelSurfaces(rightPanelState.surfaces);
    useRightPanelStore.getState().closeAllSurfaces(activeThreadRef);
  }, [activeThreadRef, cleanupRightPanelSurfaces, rightPanelState.surfaces]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (!serverThread) {
        return AsyncResult.success(undefined);
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
      });
      if (metadataUpdate) {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: input.interactionMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
      }
      return result;
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  // State mirror of the follow mode refs. LegendList's maintainScrollAtEnd
  // re-pins on its own (independent of the refs), so the timeline needs a
  // render-visible flag to switch it off once the user scrolls away.
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true);
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  // Manual navigation stops live-follow without removing anchored end space.
  // Collapsing that space during a gesture clamps the viewport back to the end.
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1;
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    setTimelineLiveFollowEnabled(false);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
  }, []);
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigation,
  );
  useEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigation;
  }, [cancelTimelineLiveFollowForUserNavigation]);
  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || anchorIndex === null) {
        return null;
      }

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      });
    },
    [composerOverlayHeight],
  );
  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || state.data.length === 0) {
        return false;
      }

      const lastRowIndex = state.data.length - 1;
      const lastRowTop = state.positionAtIndex(lastRowIndex);
      const lastRowHeight = state.sizeAtIndex(lastRowIndex);
      if (
        typeof lastRowTop !== "number" ||
        typeof lastRowHeight !== "number" ||
        !Number.isFinite(lastRowTop) ||
        !Number.isFinite(lastRowHeight)
      ) {
        return false;
      }

      const realContentBottom = lastRowTop + Math.max(1, lastRowHeight);
      const visibleScrollLength = Math.max(
        0,
        (state.scrollLength ?? 0) - composerOverlayHeight - CHAT_LIST_ANCHOR_OFFSET,
      );
      return realContentBottom > visibleScrollLength;
    },
    [composerOverlayHeight],
  );
  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback((animated = false) => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor(releaseChatTimelineAnchor);
    requestAnimationFrame(() => {
      void legendListRef.current?.scrollToEnd?.({ animated });
    });
  }, []);
  useLayoutEffect(() => {
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      return;
    }

    if (
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId: timelineAnchorMessageId,
        liveFollowEnabled: timelineLiveFollowEnabled,
        runningTurnId: activeRunningTurnId,
        timelineEntries,
      })
    ) {
      scrollToEnd();
    }
  }, [
    activeRunningTurnId,
    scrollToEnd,
    timelineAnchorMessageId,
    timelineEntries,
    timelineLiveFollowEnabled,
  ]);
  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const scrollNode = legendListRef.current?.getScrollableNode();
        if (!scrollNode) {
          // The list may not have mounted on the first frame after a thread
          // switch — without a retry the opt-out listeners never attach and
          // live-follow becomes impossible to escape for the whole thread.
          if (remainingAttempts > 0) {
            attach(remainingAttempts - 1);
          }
          return;
        }
        const handleManualNavigation = () => {
          cancelTimelineLiveFollowForUserNavigationRef.current();
        };
        // The gestures below must only break follow when they can actually
        // move the viewport away from the live edge. Follow now gates
        // LegendList's maintainScrollAtEnd, so a spurious break while pinned
        // at the end produces no scroll event, never re-arms, and streaming
        // silently stops following. Underflowing content can't scroll at all,
        // so nothing there should break follow.
        const contentScrollsUp = () => timelineRealContentOverflowsViewport();
        // The follow re-arm band, not the strict flag: streaming growth makes
        // isAtEnd flicker false for a frame before the follow scroll catches
        // up, and a gesture landing in that window while still pinned would
        // otherwise break follow with no scroll event left to re-arm it.
        const viewportIsAwayFromEnd = () =>
          resolveTimelineIsAtEnd(legendListRef.current?.getState(), composerOverlayHeight) ===
          false;
        // Only an upward wheel is a navigation intent; wheeling down while
        // following either does nothing (at the end) or moves toward it.
        const handleWheel = (event: WheelEvent) => {
          if (event.deltaY < 0 && contentScrollsUp()) {
            handleManualNavigation();
          }
        };
        // Touch direction isn't observable here (touchmove fires on any
        // finger motion, scrolling or not), so break only once the drag has
        // actually carried the viewport out of the end band — an upward flick
        // gets there within its first few events and later touchmoves break.
        const handleTouchMove = () => {
          if (viewportIsAwayFromEnd()) {
            handleManualNavigation();
          }
        };
        // Scrollbar drags produce no wheel/touch events; they are the only
        // pointerdowns whose target is the scroll node itself rather than a
        // message row. Content clicks break follow only away from the end
        // (reading or selecting up there must hold position); clicking near
        // the live edge keeps following.
        const handlePointerDown = (event: PointerEvent) => {
          if (event.target === scrollNode) {
            if (contentScrollsUp()) {
              handleManualNavigation();
            }
            return;
          }
          if (viewportIsAwayFromEnd()) {
            handleManualNavigation();
          }
        };
        // Keyboard scrolling (PageUp/Home/ArrowUp) bypasses wheel and
        // pointer events entirely; without this the timeline yanks back to
        // the end on the next stream chunk.
        const handleKeyDown = (event: KeyboardEvent) => {
          switch (event.key) {
            case "PageUp":
            case "Home":
            case "ArrowUp":
              if (contentScrollsUp()) {
                handleManualNavigation();
              }
              break;
            default:
              break;
          }
        };
        scrollNode.addEventListener("wheel", handleWheel, {
          passive: true,
        });
        scrollNode.addEventListener("touchmove", handleTouchMove, {
          passive: true,
        });
        scrollNode.addEventListener("pointerdown", handlePointerDown, {
          passive: true,
        });
        scrollNode.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          scrollNode.removeEventListener("wheel", handleWheel);
          scrollNode.removeEventListener("touchmove", handleTouchMove);
          scrollNode.removeEventListener("pointerdown", handlePointerDown);
          scrollNode.removeEventListener("keydown", handleKeyDown);
        };
      });
    };
    attach(12);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      removeListeners?.();
    };
  }, [activeThread?.id, composerOverlayHeight, timelineRealContentOverflowsViewport]);

  const onTimelineAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) => {
    // Anchored-end space can be remeasured when the turn completes. Once the
    // user has scrolled away (or returned to ordinary end-following), that
    // remeasurement must not restart the send-time anchor positioning.
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      return;
    }
    if (pendingTimelineAnchorRef.current === messageId) {
      pendingTimelineAnchorRef.current = null;
    }
    activeTimelineAnchorIndexRef.current = anchorIndex;
    if (positionedTimelineAnchorRef.current === messageId) {
      return;
    }
    positionedTimelineAnchorRef.current = messageId;
    settledTimelineAnchorRef.current = null;
    const positionAnchor = (remainingAttempts: number) => {
      requestAnimationFrame(() => {
        if (positionedTimelineAnchorRef.current !== messageId) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          if (remainingAttempts > 0) {
            positionAnchor(remainingAttempts - 1);
          }
          return;
        }
        void list
          .scrollToIndex({
            index: anchorIndex,
            animated: true,
            viewPosition: 0,
            viewOffset: CHAT_LIST_ANCHOR_OFFSET,
          })
          .then(() => {
            if (positionedTimelineAnchorRef.current !== messageId) {
              return;
            }
            settledTimelineAnchorRef.current = messageId;
          });
      });
    };
    requestAnimationFrame(() => positionAnchor(12));
  }, []);

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      // Reachable only once manual navigation has already broken follow, so
      // the anchored turn framing is over: the user scrolled back to the live
      // edge and expects the stream to stick to it again, exactly like the
      // scroll-to-bottom pill.
      setTimelineAnchor(releaseChatTimelineAnchor);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  // Anchored end space intentionally disables LegendList's normal end-follow so
  // the sent message can stay near the top. cadsense only owns streaming adjustments
  // during that mode; LegendList owns ordinary end-follow everywhere else.
  useEffect(() => {
    if (!activeThread?.id) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
      return;
    }
    if (timelineScrollModeRef.current !== "anchoring-new-turn") {
      return;
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
          return;
        }
        if (pendingTimelineAnchorRef.current !== null) {
          return;
        }
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        ) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          return;
        }

        const metrics = getActiveTimelineTurnMetrics(list);
        if (!metrics || metrics.scrollDeltaToRevealEnd <= 1) {
          return;
        }

        const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd;
        void list.scrollToOffset({ offset: nextOffset, animated: false });
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [activeThread?.id, timelineEntries, getActiveTimelineTurnMetrics]);

  useEffect(() => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    // activeThreadRef resets transitively with the active thread.
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    cancelVideoPreviewRequest();
    setOpeningVideoAttachmentId(null);
    setExpandedImage(null);
  }, [cancelVideoPreviewRequest, draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeThreadShell = useThreadShell(isServerThread ? activeThreadRef : null);
  const activeComposerTasksProgress =
    activeLatestTurn !== null && !latestTurnSettled
      ? (activeThreadShell?.planProgress ?? null)
      : null;
  const activeComposerTaskSteps =
    activeComposerTasksProgress && activePlan && activePlan.turnId === activeLatestTurn?.turnId
      ? activePlan.steps
      : null;

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(composerOverlayElement.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setComposerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
      const nextClearance = Math.max(0, nextHeight - shoulderTabReserve(composerOverlayElement));
      setScrollToEndClearance((currentClearance) =>
        currentClearance === nextClearance ? currentClearance : nextClearance,
      );
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(composerOverlayElement);
    const tabObserver = new MutationObserver(updateHeight);
    tabObserver.observe(composerOverlayElement, { childList: true, subtree: true });
    return () => {
      resizeObserver.disconnect();
      tabObserver.disconnect();
    };
  }, [composerOverlayElement]);

  // Background work (subagent fleets, workflow runs, watch loops) can outlive
  // the turn; once it settles, the composer stop button is gone, so this
  // banner is the only visible stop affordance. Stop routes through the
  // stop-everything interrupt: it kills every live background task before
  // interrupting, and works by session, so no active turn is needed.
  const activeBackgroundLiveness =
    !isWorking && activeThread ? (activeThreadShell?.backgroundLiveness ?? null) : null;
  const [isStoppingBackgroundWork, setIsStoppingBackgroundWork] = useState(false);
  useEffect(() => {
    // "Stopping..." holds until the liveness clears; the interrupt command
    // returning only means the request was accepted.
    if (activeBackgroundLiveness === null) {
      setIsStoppingBackgroundWork(false);
    }
  }, [activeBackgroundLiveness]);
  useEffect(() => {
    // Per-thread state: switching threads while A's stop is pending must not
    // disable B's Stop button.
    setIsStoppingBackgroundWork(false);
  }, [activeThreadId]);
  const handleStopBackgroundWork = useCallback(async () => {
    if (!activeThread) return;
    setIsStoppingBackgroundWork(true);
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    });
    if (result._tag === "Failure") {
      // Every failure clears the pending state — an interrupted command
      // never reached the server, so liveness would hold "Stopping..."
      // forever. Only real failures toast.
      setIsStoppingBackgroundWork(false);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to stop background work.",
        );
      }
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError]);
  const backgroundLivenessBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (activeBackgroundLiveness === null || !activeThread) {
      return null;
    }
    const working = activeBackgroundLiveness === "working";
    const liveCount = agentPanelModel.liveCount;
    return {
      id: `background-liveness:${activeThread.id}`,
      variant: "default",
      icon: (
        <span
          className={cn("size-1.5 rounded-full bg-foreground", working && "animate-status-pulse")}
          aria-hidden="true"
        />
      ),
      title: working
        ? liveCount > 0
          ? `${liveCount} ${liveCount === 1 ? "agent" : "agents"} working`
          : "Background work"
        : "Monitoring",
      actions: (
        <Button
          size="xs"
          variant="ghost"
          disabled={isStoppingBackgroundWork}
          onClick={() => void handleStopBackgroundWork()}
        >
          {isStoppingBackgroundWork ? "Stopping..." : "Stop"}
        </Button>
      ),
    };
  }, [
    activeBackgroundLiveness,
    activeThread,
    agentPanelModel.liveCount,
    handleStopBackgroundWork,
    isStoppingBackgroundWork,
  ]);
  const nowMinute = useNowMinute();
  // Session-scoped dismissals, one key per (thread, snapshot). A set rather
  // than a single slot so dismissing the banner on one thread does not
  // resurface it on another thread dismissed earlier.
  const [dismissedResumeCompactionKeys, setDismissedResumeCompactionKeys] = useState<
    ReadonlySet<string>
  >(new Set());
  const resumeCompactionKey =
    activeThread && activeContextWindow
      ? `${activeThread.id}:${activeContextWindow.updatedAt}`
      : null;
  const compactDisabled =
    !activeThread ||
    !activeProject ||
    !isServerThread ||
    selectedProvider !== "claudeAgent" ||
    !compactionProviderAvailable ||
    isWorking ||
    threadDetailLoading ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    showPlanFollowUpPrompt ||
    composerHasUnsentContent;
  const compactDisabledReason = compactDisabled
    ? composerHasUnsentContent
      ? "Send or clear your draft before compacting"
      : !activeProject
        ? "Choose a project before compacting"
        : !compactionProviderAvailable
          ? "Enable a Claude provider before compacting"
          : "Compacting is unavailable right now"
    : null;
  const resumeCompactionBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (
      !activeThread ||
      !activeContextWindow ||
      resumeCompactionKey === null ||
      dismissedResumeCompactionKeys.has(resumeCompactionKey) ||
      resumeCompactionPermanentlyDismissed ||
      nativeResumeCompactionDismissed ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      !shouldOfferResumeCompaction({
        provider: selectedProvider,
        usedTokens: activeContextWindow.usedTokens,
        updatedAt: activeContextWindow.updatedAt,
        now: `${nowMinute}:00.000Z`,
      })
    ) {
      return null;
    }

    const dismiss = () =>
      setDismissedResumeCompactionKeys((keys) => new Set(keys).add(resumeCompactionKey));
    const compactAction = (
      <Button
        size="xs"
        variant="outline"
        disabled={compactDisabled}
        onClick={() => {
          if (compactDisabled) return;
          composerRef.current?.compactContext();
        }}
      >
        Compact
      </Button>
    );
    return {
      id: `resume-compaction:${resumeCompactionKey}`,
      variant: "info",
      icon: <Minimize2Icon />,
      title: "Resume with less context",
      description: `${formatContextWindowTokens(activeContextWindow.usedTokens)} tokens from an older session`,
      actions: compactDisabledReason ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex">{compactAction}</span>} />
          <TooltipPopup side="top">{compactDisabledReason}</TooltipPopup>
        </Tooltip>
      ) : (
        compactAction
      ),
      dismissLabel: "Keep full history",
      onDismiss: dismiss,
    };
  }, [
    activeContextWindow,
    activeThread,
    compactDisabled,
    compactDisabledReason,
    composerRef,
    dismissedResumeCompactionKeys,
    nativeResumeCompactionDismissed,
    nowMinute,
    pendingUserInputs.length,
    phase,
    resumeCompactionKey,
    resumeCompactionPermanentlyDismissed,
    selectedProvider,
  ]);
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const isUrgentSystemItem = (item: ComposerBannerStackItem) =>
      item.urgent === true || item.variant === "error" || item.variant === "warning";
    const urgentSystemItems = systemComposerBannerItems.filter(isUrgentSystemItem);
    const calmSystemItems = systemComposerBannerItems.filter((item) => !isUrgentSystemItem(item));
    return [
      ...urgentSystemItems,
      ...(backgroundLivenessBannerItem === null ? [] : [backgroundLivenessBannerItem]),
      ...calmSystemItems,
      ...(resumeCompactionBannerItem === null ? [] : [resumeCompactionBannerItem]),
    ];
  }, [backgroundLivenessBannerItem, resumeCompactionBannerItem, systemComposerBannerItems]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      const shortcutContext = {
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      if (!shortcutContext.modelPickerOpen && shouldTypeToFocusComposer(event)) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanel();
        return;
      }

      if (command === "rightPanel.toggleMaximized") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanelMaximized();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeThreadId, keybindings, toggleRightPanel, toggleRightPanelMaximized, composerRef]);

  const onSend = async (
    e?: { preventDefault: () => void },
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
  ) => {
    e?.preventDefault();
    const notifyDirectAnnotationAttached = () => {
      if (!directAnnotation) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Annotation attached to draft",
          description: "Sending is unavailable right now. Finish the current action, then send.",
        }),
      );
    };
    if (
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      threadDetailLoading ||
      cadOpeningRef.current ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    if (activeEnvironmentUnavailable) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Not connected: message not sent",
          description: "Reconnecting to the environment. Try again once it is connected.",
        }),
      );
      return;
    }
    if (activePendingProgress) {
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      notifyDirectAnnotationAttached();
      return;
    }
    const {
      images: sendContextImages,
      files: composerFiles,
      elementContexts: composerElementContexts,
      previewAnnotations: sendContextPreviewAnnotations,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;
    const annotationImageAlreadyAttached =
      directAnnotation?.image !== undefined &&
      sendContextImages.some((image) => image.id === directAnnotation.image?.id);
    // A full composer (e.g. 8 files) cannot take the annotation screenshot;
    // over the cap the server rejects the whole turn.
    const annotationImageAppended =
      directAnnotation?.image !== undefined &&
      !annotationImageAlreadyAttached &&
      sendContextImages.length + composerFiles.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const composerImages =
      directAnnotation?.image && annotationImageAppended
        ? [...sendContextImages, directAnnotation.image]
        : sendContextImages;
    const composerPreviewAnnotations =
      directAnnotation &&
      !sendContextPreviewAnnotations.some(
        (annotation) => annotation.id === directAnnotation.annotation.id,
      )
        ? [
            ...sendContextPreviewAnnotations,
            {
              ...directAnnotation.annotation,
              // Claim an attached crop only when the screenshot really rides
              // along; a cap-dropped image must not produce a lying prompt.
              screenshot:
                directAnnotation.annotation.screenshot &&
                (annotationImageAppended || annotationImageAlreadyAttached)
                  ? { ...directAnnotation.annotation.screenshot, dataUrl: "" }
                  : null,
            },
          ]
        : sendContextPreviewAnnotations;
    const promptForSend = promptRef.current;
    const { trimmedPrompt: trimmed, hasSendableContent } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length + composerFiles.length,
      elementContextCount: composerElementContexts.length + composerPreviewAnnotations.length,
    });
    const feedbackCommand =
      ctxSelectedProvider === "codex" &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0
        ? parseCodexFeedbackCommand(trimmed)
        : null;
    if (feedbackCommand) {
      if (!isServerThread || activeThread.session === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start a Codex thread first",
            description: "Send a message before you submit feedback.",
          }),
        );
        return;
      }
      feedbackUploadsInFlightRef.current.add(routeThreadKey);
      const result = await submitCodexFeedback({
        submission: {
          id: newMessageId(),
          command: trimmed,
          createdAt: new Date().toISOString(),
        },
        clearDraft: () => {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
          scrollToEnd();
        },
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[routeThreadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [routeThreadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId,
            input: {
              threadId: activeThread.id,
              ...feedbackCommand,
            },
          }),
      }).finally(() => {
        feedbackUploadsInFlightRef.current.delete(routeThreadKey);
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not send feedback to OpenAI",
              description: chatActionErrorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return;
      }
      const feedbackId = result.value.feedbackId;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Feedback sent to OpenAI",
          description: `Thread ID: ${feedbackId}`,
          timeout: 0,
          actionProps: {
            children: "Copy ID",
            onClick: () => {
              void writeTextToClipboard(feedbackId, "Codex feedback thread ID").catch(
                (error: unknown) => {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Could not copy thread ID",
                      description: chatActionErrorMessage(error),
                    }),
                  );
                },
              );
            },
          },
        }),
      );
      return;
    }
    if (
      !directAnnotation &&
      showPlanFollowUpPrompt &&
      activeProposedPlan &&
      composerImages.length === 0 &&
      composerFiles.length === 0
    ) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const outgoingFollowUpText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: followUp.text.trim(),
      });
      if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
        return;
      }
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    if (!hasSendableContent) {
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const composerImagesSnapshot = [...composerImages];
    const composerFilesSnapshot = [...composerFiles];
    const composerAttachmentsSnapshot = [...composerImagesSnapshot, ...composerFilesSnapshot];
    const composerElementContextsSnapshot = [...composerElementContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const messageTextWithContexts = appendElementContextsToPrompt(
      promptForSend,
      composerElementContextsSnapshot,
    );
    const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
      (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
      messageTextWithContexts,
    );
    const messageTextForSend = messageTextWithPreviewAnnotations;
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
      return;
    }

    const readLiveAttachmentCapabilities = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const liveSupportsAttachmentUploads =
        config?.environment.capabilities.attachmentUploads === true;
      return {
        supportsAttachmentUploads: liveSupportsAttachmentUploads,
        fileBlockReason: fileAttachmentCapabilityBlockReason({
          files: composerFilesSnapshot,
          attachmentUploadsCapabilityKnown: config !== null,
          supportsAttachmentUploads: liveSupportsAttachmentUploads,
          maxFileAttachmentBytes:
            config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
        }),
      };
    };

    sendInFlightRef.current = true;
    const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
      return;
    }
    const turnUsesAttachmentUploads =
      composerFilesSnapshot.length > 0
        ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
        : supportsAttachmentUploads;
    if (turnUsesAttachmentUploads && composerAttachmentsSnapshot.length > 0) {
      for (const attachment of composerAttachmentsSnapshot) {
        startAttachmentUpload({
          environmentId,
          image: attachment,
          draftTarget: composerDraftTarget,
        });
      }
      await awaitAttachmentUploads(composerAttachmentsSnapshot.map((attachment) => attachment.id));
      const attachmentCapabilitiesAfterUpload = readLiveAttachmentCapabilities();
      if (attachmentCapabilitiesAfterUpload.fileBlockReason !== null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
        return;
      }
      if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
        return;
      }
    }

    const resolvedSubmissionIntent =
      submissionIntent === "background" && isLocalDraftThread ? "background" : "foreground";
    if (
      shouldDockDraftHeroForSubmission({
        isDraftHeroState,
        activeThreadKey,
        submissionIntent: resolvedSubmissionIntent,
      }) &&
      activeThreadKey
    ) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      flushSync(() => {
        captureDraftHeroComposerRect();
        setDockedDraftHeroThreadKey(activeThreadKey);
      });
      resolveDockStarted?.();
      await dockStarted;
    }

    const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeDispatch.fileBlockReason);
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      return;
    }
    beginLocalDispatch({
      submissionIntent: resolvedSubmissionIntent,
    });

    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const turnAttachmentsPromise = Promise.all(
      composerAttachmentsSnapshot.map(async (attachment) => {
        if (turnUsesAttachmentUploads) {
          const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
          if (!uploaded) {
            throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
          }
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
        };
      }),
    );
    const optimisticAttachments = composerAttachmentsSnapshot.map((attachment) =>
      attachment.type === "image"
        ? {
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: attachment.previewUrl,
          }
        : {
            type: "file" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            downloadable: false,
          },
    );
    const shouldAnchorFirstMessage =
      activeThread.latestTurn === null &&
      !timelineMessages.some((message) => message.role === "user");
    if (shouldAnchorFirstMessage) {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "anchoring-new-turn";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      pendingTimelineAnchorRef.current = messageIdForSend;
      activeTimelineAnchorIndexRef.current = null;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      setTimelineAnchor({
        threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageId: messageIdForSend,
      });
    } else {
      scrollToEnd();
    }
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        turnId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    setThreadError(threadIdForSend, null);
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = trimmed;
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerFilesSnapshot[0]) {
        titleSeed = `File: ${composerFilesSnapshot[0].name}`;
      } else if (composerElementContextsSnapshot.length > 0) {
        titleSeed = formatElementContextLabel(composerElementContextsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;
    // Auto-title from first message
    if (isFirstMessage && isServerThread) {
      const titleResult = await updateThreadMetadata({
        environmentId,
        input: {
          threadId: threadIdForSend,
          title,
        },
      });
      if (titleResult._tag === "Failure") {
        failure = titleResult;
      }
    }

    if (failure === null && isServerThread) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
        runtimeMode,
        interactionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(async () => {
      const turnAttachments = await turnAttachmentsPromise;
      const liveFileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
      if (liveFileBlockReason !== null) {
        throw new Error(liveFileBlockReason);
      }
      return turnAttachments;
    });
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap = isLocalDraftThread
        ? {
            createThread: {
              projectId: activeProject.id,
              title,
              modelSelection: threadCreateModelSelection,
              runtimeMode,
              interactionMode,
              createdAt: activeThread.createdAt,
            },
          }
        : undefined;
      const backgroundThreadRef =
        resolvedSubmissionIntent === "background"
          ? scopeThreadRef(activeThread.environmentId, threadIdForSend)
          : null;
      if (backgroundThreadRef) {
        beginBackgroundDraftSubmissionByRef(backgroundThreadRef);
      }
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachmentsResult.value,
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          ...(bootstrap ? { bootstrap } : {}),
          createdAt: messageCreatedAt,
        },
      });
      if (startResult._tag === "Failure") {
        if (backgroundThreadRef) {
          clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
        }
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        if (turnUsesAttachmentUploads) {
          releaseDraftAttachments(composerAttachmentsSnapshot);
        }
        if (backgroundThreadRef) {
          markPromotedDraftThreadByRef(backgroundThreadRef);
          try {
            const nextDraft = await handleNewThread(
              scopeProjectRef(activeProject.environmentId, activeProject.id),
            );
            if (nextDraft) {
              finalizePromotedDraftThreadByRef(backgroundThreadRef);
              toastManager.add(
                stackedThreadToast({
                  type: "success",
                  title: "Started in background",
                  timeout: 5_000,
                  actionProps: {
                    children: "Open",
                    onClick: () => {
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(backgroundThreadRef),
                      });
                    },
                  },
                }),
              );
            } else {
              clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
            }
          } catch (error) {
            clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
            resetLocalDispatch();
            toastManager.add(
              stackedThreadToast({
                type: "warning",
                title: "Task started in the background",
                description:
                  error instanceof Error
                    ? `Could not open a fresh composer: ${error.message}`
                    : "Could not open a fresh composer.",
              }),
            );
          }
        }
      }
    }

    if (failure !== null) {
      if (
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerFilesRef.current.length === 0 &&
        composerElementContextsRef.current.length === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.previewAnnotations
          .length ?? 0) === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerFilesRef.current = composerFilesSnapshot;
        composerElementContextsRef.current = composerElementContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        addComposerDraftFiles(composerDraftTarget, composerFilesSnapshot);
        setComposerDraftElementContexts(composerDraftTarget, composerElementContextsSnapshot);
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        if (isLocalDraftThread && draftId && wasBootstrapThreadDeleted(error)) {
          const failedDraftSession = getDraftSession(draftId);
          if (failedDraftSession?.threadId === threadIdForSend) {
            setLogicalProjectDraftThreadId(
              failedDraftSession.logicalProjectKey,
              scopeProjectRef(failedDraftSession.environmentId, failedDraftSession.projectId),
              draftId,
              {
                threadId: newThreadId(),
                createdAt: new Date().toISOString(),
              },
            );
          }
        }
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
      }
    }
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      resetLocalDispatch();
    }
  };

  const onInterrupt = async () => {
    if (!activeThread) return;
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadApproval, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          answers,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
      }
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadUserInput, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      if (
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginLocalDispatch();
      setThreadError(threadIdForSend, null);

      scrollToEnd();

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: ctxSelectedModelSelection,
        runtimeMode,
        interactionMode: nextInteractionMode,
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode,
            interactionMode: nextInteractionMode,
            ...(nextInteractionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread.id,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) {
        sendInFlightRef.current = false;
        return;
      }

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send plan follow-up.",
        );
      }
      sendInFlightRef.current = false;
      resetLocalDispatch();
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      scrollToEnd,
      setComposerDraftInteractionMode,
      setThreadError,
      startThreadTurn,
      environmentId,
      composerRef,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    if (composerRef.current?.validateProviderInput(outgoingImplementationPrompt) === false) {
      return;
    }
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch();
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  }, [
    activeProject,
    activeProposedPlan,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    startThreadTurn,
    environmentId,
    composerRef,
  ]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!activeThread) {
        return null;
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeThread, providerStatuses],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        scheduleComposerFocus();
        return;
      }
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
        { explicit: true },
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onExpandTimelineImage = useCallback(
    (preview: ExpandedImagePreview) => {
      cancelVideoPreviewRequest();
      setOpeningVideoAttachmentId(null);
      setExpandedImage(preview);
    },
    [cancelVideoPreviewRequest],
  );
  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const panelToggleControls = (
    <PanelLayoutControls
      rightPanelAvailable={activeProject !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      // Suppressed while the Agents surface is visible: the roster itself is
      // on screen, so the toggle badge would be pointing at nothing.
      liveAgentCount={
        rightPanelOpen && activeRightPanelSurface?.kind === "agents" ? 0 : agentPanelModel.liveCount
      }
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const panelLayoutControls = (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      {rightPanelOpen && !shouldUseRightPanelSheet ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  );
  const rightPanelContent = activeThreadRef ? (
    displayedRightPanelSurface?.kind === "cad" && activeProject ? (
      <Suspense fallback={null}>
        {cadAvailable && isServerThread ? (
          <CadPanel key={activeThreadKey} project={activeProject} threadRef={activeThreadRef} />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">
            {cadAvailable
              ? "Start a thread to open its CAD view."
              : "CAD is not available for this project."}
          </div>
        )}
      </Suspense>
    ) : displayedRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={displayedRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible
          onSendAnnotation={(annotation, image) => {
            void onSend(undefined, "foreground", { annotation, image });
          }}
        />
      </Suspense>
    ) : displayedRightPanelSurface?.kind === "agents" ? (
      <AgentsPanel
        model={agentPanelModel}
        environmentId={activeThreadRef?.environmentId ?? null}
        threadId={activeThreadRef?.threadId ?? null}
      />
    ) : (displayedRightPanelSurface?.kind === "files" ||
        displayedRightPanelSurface?.kind === "file") &&
      activeProject &&
      activeWorkspaceRoot ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeProject.environmentId}:${activeWorkspaceRoot}`}
          environmentId={activeProject.environmentId}
          cwd={activeWorkspaceRoot}
          projectName={activeProject.title}
          threadRef={activeThreadRef}
          relativePath={
            displayedRightPanelSurface.kind === "file"
              ? displayedRightPanelSurface.relativePath
              : null
          }
          revealLine={activeFileSurface?.revealLine ?? null}
          revealRequestId={activeFileSurface?.revealRequestId ?? 0}
          onOpenFile={openFileSurface}
          onPendingChange={handleFilePendingChange}
          selectedFilePending={
            activeFileSurface !== null && pendingFileSurfaceIds.has(activeFileSurface.id)
          }
          workspaceMutationId={workspaceMutationId}
        />
      </Suspense>
    ) : null
  ) : null;

  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: (files) => composerRef.current?.addDroppedFiles(files),
  });
  const externalComposerDrawerAttached =
    composerBannerItems.length > 0 || Boolean(threadSyncPhase && !activeEnvironmentUnavailable);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      {!shouldUseRightPanelSheet || !rightPanelOpen ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {/* Top bar */}
        <WorkspacePageHeader
          data-chat-header
          electron={isElectron}
          reserveNativeControls={reserveTitleBarControlInset && !inlineRightPanelOwnsTitleBar}
          className="relative bg-background"
        >
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            activeThreadTitle={activeThread.title}
            isServerThread={isServerThread}
            activeProjectName={activeProject?.title}
            activeProjectCwd={activeProject?.workspaceRoot ?? null}
            activeProjectOnshapeSource={activeProject?.onshapeSource}
            openInCwd={activeProject?.workspaceRoot ?? null}
            rightPanelOpen={rightPanelOpen}
            onNewThreadInProject={handleNewThreadInActiveProject}
          />
        </WorkspacePageHeader>

        <ThreadErrorBanner
          error={visibleThreadError}
          onDismiss={() => {
            setThreadError(activeThread.id, null);
            dismissThreadErrorBannerForSession(threadErrorBannerKey);
            setThreadErrorBannerDismissTick((tick) => tick + 1);
          }}
        />
        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            {isWorkspaceFileDragActive ? (
              <div
                className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
                data-chat-workspace-drop-overlay="true"
              >
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            {/* Provider status overlays the timeline without changing its content height. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
              />
            </div>
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <MessagesTimeline
                agentPanelModel={agentPanelModel}
                onOpenAgents={addAgentsSurface}
                key={activeThread.id}
                isWorking={isWorking}
                workingStepLabel={workingStepLabel}
                activeTurnStartedAt={activeWorkStartedAt}
                listRef={legendListRef}
                timelineEntries={timelineEntries}
                latestTurn={activeLatestTurn}
                runningTurnId={activeRunningTurnId}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                onImageExpand={onExpandTimelineImage}
                onFileOpen={openFileAttachment}
                openingVideoAttachmentId={openingVideoAttachmentId}
                markdownCwd={activeWorkspaceRoot}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
                anchorMessageId={timelineAnchorMessageId}
                onAnchorReady={onTimelineAnchorReady}
                contentInsetEndAdjustment={composerOverlayHeight}
                liveFollowEnabled={timelineLiveFollowEnabled}
                onIsAtEndChange={onIsAtEndChange}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                topFadeEnabled={!hasTimelineTopBanner}
                loadEarlier={loadEarlierTurns}
              />

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && (
                <div
                  className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                  style={{ bottom: scrollToEndClearance + 4 }}
                >
                  <Button
                    aria-label="Scroll to end"
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
                    size="xs"
                    variant="glass"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                  </Button>
                </div>
              )}
            </div>

            {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
            <div
              ref={setComposerOverlayElement}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div
                ref={attachDraftHeroTransitionGroupRef}
                className="w-full ps-[calc(env(safe-area-inset-left)+0.75rem)] pe-[calc(env(safe-area-inset-right)+0.75rem)] sm:ps-[calc(env(safe-area-inset-left)+1.25rem)] sm:pe-[calc(env(safe-area-inset-right)+1.25rem)]"
              >
                <div className="group/composer-stack pointer-events-auto relative z-10">
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div className="pb-8 group-has-[.chat-composer-shoulder-tab]/composer-stack:pb-4">
                        <DraftHeroHeadline
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                      <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                    </div>
                  ) : (
                    <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                  )}
                  {threadSyncPhase && !activeEnvironmentUnavailable ? (
                    <ThreadSyncStatusPill phase={threadSyncPhase} />
                  ) : null}
                  <div className="relative">
                    <div
                      className={cn(
                        "chat-composer-glass-shell relative mx-auto w-full max-w-3xl",
                        externalComposerDrawerAttached && "chat-composer-glass-shell-attached",
                      )}
                    >
                      <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                        <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                          <ChatComposer
                            composerRef={composerRef}
                            composerDraftTarget={composerDraftTarget}
                            environmentId={environmentId}
                            attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                            supportsAttachmentUploads={supportsAttachmentUploads}
                            maxFileAttachmentBytes={maxFileAttachmentBytes}
                            routeKind={routeKind}
                            routeThreadRef={routeThreadRef}
                            draftId={draftId}
                            activeThreadId={activeThreadId}
                            activeThreadEnvironmentId={activeThread?.environmentId}
                            activeThread={activeThread}
                            isServerThread={isServerThread}
                            isLocalDraftThread={isLocalDraftThread}
                            projectSelectionRequired={isLocalDraftThread && activeProject === null}
                            phase={phase}
                            isConnecting={isConnecting}
                            isSendBusy={isSendBusy || cadOpening}
                            sendDisabledReason={
                              feedbackUploading
                                ? "Sending feedback"
                                : threadDetailLoading
                                  ? "Messages loading"
                                  : null
                            }
                            externalDrawerAttached={externalComposerDrawerAttached}
                            environmentUnavailable={activeEnvironmentUnavailableState}
                            activePendingApproval={activePendingApproval}
                            pendingApprovals={pendingApprovals}
                            pendingUserInputs={pendingUserInputs}
                            activePendingProgress={activePendingProgress}
                            activePendingResolvedAnswers={activePendingResolvedAnswers}
                            activePendingIsResponding={activePendingIsResponding}
                            activePendingDraftAnswers={activePendingDraftAnswers}
                            activePendingQuestionIndex={activePendingQuestionIndex}
                            respondingRequestIds={respondingRequestIds}
                            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                            activeProposedPlan={activeProposedPlan}
                            activeTasksProgress={activeComposerTasksProgress}
                            activeTaskSteps={activeComposerTaskSteps}
                            runtimeMode={runtimeMode}
                            lockedProvider={lockedProvider}
                            providerStatuses={providerStatuses as ServerProvider[]}
                            activeProjectDefaultModelSelection={
                              activeProject?.defaultModelSelection
                            }
                            activeThreadModelSelection={activeThread?.modelSelection}
                            activeContextWindow={activeContextWindow}
                            compactDisabled={compactDisabled}
                            compactDisabledReason={compactDisabledReason}
                            settings={settings}
                            keybindings={keybindings}
                            projectCwd={activeProject?.workspaceRoot ?? null}
                            promptRef={promptRef}
                            composerImagesRef={composerImagesRef}
                            composerFilesRef={composerFilesRef}
                            composerElementContextsRef={composerElementContextsRef}
                            onSend={onSend}
                            onInterrupt={onInterrupt}
                            onImplementPlanInNewThread={onImplementPlanInNewThread}
                            onRespondToApproval={onRespondToApproval}
                            onSelectActivePendingUserInputOption={
                              onSelectActivePendingUserInputOption
                            }
                            onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                            onPreviousActivePendingUserInputQuestion={
                              onPreviousActivePendingUserInputQuestion
                            }
                            onChangeActivePendingUserInputCustomAnswer={
                              onChangeActivePendingUserInputCustomAnswer
                            }
                            onProviderModelSelect={onProviderModelSelect}
                            getModelDisabledReason={getModelDisabledReason}
                            handleRuntimeModeChange={handleRuntimeModeChange}
                            focusComposer={focusComposer}
                            scheduleComposerFocus={scheduleComposerFocus}
                            setThreadError={setThreadError}
                            onExpandImage={onExpandTimelineImage}
                            onFileOpen={openFileAttachment}
                            openingVideoAttachmentId={openingVideoAttachmentId}
                          />
                        </div>
                      </div>
                    </div>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {activeThreadRef && activePreviewMiniPlayer ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${activePreviewMiniPlayer.tabId}`}
                threadRef={activeThreadRef}
                tabId={activePreviewMiniPlayer.tabId}
                bottomInset={isDraftHeroState ? 0 : composerOverlayHeight}
              />
            ) : null}
          </div>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}
      </div>

      {!shouldUseRightPanelSheet && rightPanelPresence.present && activeThreadRef ? (
        <RightPanelTabs
          open={rightPanelOpen}
          onExited={rightPanelPresence.onExited}
          onAddCad={addCadSurface}
          cadAvailable={cadAvailable}
          mode="inline"
          maximized={rightPanelMaximized}
          surfaces={rightPanelState.surfaces}
          activeSurfaceId={displayedRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onCopyFilePath={copyRightPanelFilePath}
          onAddBrowser={createBrowserSurface}
          onAddFiles={addFilesSurface}
          onAddAgents={addAgentsSurface}
          browserAvailable={isPreviewSupportedInRuntime()}
          filesAvailable={activeProject !== null}
          agentsAvailable
          liveAgentCount={agentPanelModel.liveCount}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {shouldUseRightPanelSheet && rightPanelPresence.present && activeThreadRef ? (
        <RightPanelSheet
          open={rightPanelOpen}
          onClose={closePreviewPanel}
          onExited={rightPanelPresence.onExited}
        >
          <RightPanelTabs
            onAddCad={addCadSurface}
            cadAvailable={cadAvailable}
            mode="sheet"
            // Same effective inset as the closed-state titlebar controls
            // (pr-3 in the tab bar plus this pixel equals the absolute
            // right inset plus mr-px), so the cluster does not creep when
            // the sheet opens.
            layoutControls={<div className="mr-px flex items-center">{panelToggleControls}</div>}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={displayedRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            desktopByTabId={activePreviewState.desktopByTabId}
            previewRuntimeTabId={resolvePreviewRuntimeTabId}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={createBrowserSurface}
            onAddFiles={addFilesSurface}
            onAddAgents={addAgentsSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            filesAvailable={activeProject !== null}
            agentsAvailable
            liveAgentCount={agentPanelModel.liveCount}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? "image"}:${expandedImage.index}`}
          preview={expandedImage}
          onClose={closeExpandedImage}
        />
      )}
    </div>
  );
}

export default function ChatView(props: ChatViewProps) {
  return <ChatViewContent {...props} />;
}
