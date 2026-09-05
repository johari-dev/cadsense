"use client";

import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
} from "@cadsense/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  FileSearchIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  SettingsIcon,
  SquarePenIcon,
  TextSearchIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { onOpenCommandPalette } from "../commandPaletteBus";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { readLocalApi } from "../localApi";
import { resolveShortcutCommand } from "../keybindings";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { cn, newProjectId } from "../lib/utils";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { projectEnvironment } from "../state/projects";
import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, ThreadShell } from "../types";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteOpenIntent,
  type CommandPaletteSubmenuItem,
  filterCommandPaletteGroups,
  commandPaletteThreadRouteKey,
  ITEM_ICON_CLASS,
  reduceCommandPaletteUiState,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import { OnshapeProjectCreateForm } from "./OnshapeProjectCreateForm";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  switch (command) {
    case "commandPalette.toggle":
      return "command";
    case "filePicker.toggle":
      return "files";
    case "projectSearch.toggle":
      return "content";
    default:
      return null;
  }
}

function projectIcon(project: Project) {
  return (
    <ProjectFavicon
      className={ITEM_ICON_CLASS}
      cwd={project.workspaceRoot}
      environmentId={project.environmentId}
      onshapeSource={project.onshapeSource}
    />
  );
}

function newestThreadForProject(
  threads: ReadonlyArray<ThreadShell>,
  project: Pick<Project, "environmentId" | "id">,
): ThreadShell | null {
  return (
    threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.environmentId === project.environmentId &&
          thread.projectId === project.id,
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const busyRef = useRef(false);
  const setBusy = useCallback((busy: boolean) => {
    busyRef.current = busy;
  }, []);
  const setOpen = useCallback((open: boolean) => {
    if (!busyRef.current) dispatch({ _tag: "SetOpen", open });
  }, []);
  const toggleMode = useCallback((mode: SearchOverlayMode) => {
    if (!busyRef.current) dispatch({ _tag: "ToggleMode", mode });
  }, []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mode = overlayModeForCommand(resolveShortcutCommand(event, keybindings));
      if (mode === null) return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, toggleMode]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (busyRef.current) return;
        if (detail.open === "new-thread-in") {
          dispatch({ _tag: "OpenNewThreadIn" });
        } else if (detail.open === "add-project") {
          dispatch({ _tag: "OpenAddProject" });
        } else {
          setOpen(true);
        }
      }),
    [setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (busyRef.current) {
            eventDetails.cancel();
            return;
          }
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {children}
        <CommandPaletteDialog
          clearOpenIntent={() => dispatch({ _tag: "ClearOpenIntent" })}
          mode={state.mode}
          openIntent={state.openIntent}
          openOverlayMode={toggleMode}
          setOpen={setOpen}
          setBusy={setBusy}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly setBusy: (busy: boolean) => void;
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const composerHandleRef = useComposerHandleContext();
  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn("overflow-hidden p-0", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => props.setOpen(false)}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog {...props} />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly setBusy: (busy: boolean) => void;
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const navigate = useNavigate();
  const threadRouteKey = useParams({
    strict: false,
    select: commandPaletteThreadRouteKey,
  });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopBootstraps = useDesktopLocalBootstraps();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createOnshapeProject = useAtomCommand(onshapeProjectEnvironment.create, {
    reportFailure: false,
  });
  const [onshapeEnvironmentId, setOnshapeEnvironmentId] = useState<string | null>(null);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();

  const currentProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : activeDraftThread
      ? scopeProjectRef(activeDraftThread.environmentId, activeDraftThread.projectId)
      : defaultProjectRef;

  const localEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.entry.target._tag === "PrimaryConnectionTarget" ||
          desktopLocalBackendId(environment.entry.target) !== null,
      ),
    [environments],
  );

  const environmentLabel = useCallback(
    (environment: (typeof localEnvironments)[number]) => {
      if (environment.environmentId === primaryEnvironmentId) return "This computer";
      const backendId = desktopLocalBackendId(environment.entry.target);
      return (
        desktopBootstraps.find((bootstrap) => bootstrap.id === backendId)?.label ??
        environment.label
      );
    },
    [desktopBootstraps, primaryEnvironmentId],
  );

  const openThread = useCallback(
    async (thread: ThreadShell) => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );

  const openProject = useCallback(
    async (project: Project) => {
      const latestThread = newestThreadForProject(threads, project);
      if (latestThread) {
        await openThread(latestThread);
        return;
      }
      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [handleNewThread, openThread, threads],
  );

  const addProject = useCallback(
    async (environment: (typeof localEnvironments)[number]) => {
      const api = readLocalApi();
      if (!api || environment.connection.phase !== "connected") return;
      const backendId = desktopLocalBackendId(environment.entry.target);
      let cwd: string | null;
      try {
        cwd = await api.dialogs.pickFolder(
          backendId === null ? undefined : { targetEnvironmentId: backendId },
        );
      } catch {
        return;
      }
      if (!cwd) return;

      const existing = projects.find(
        (project) =>
          project.environmentId === environment.environmentId &&
          project.workspaceRoot.toLocaleLowerCase() === cwd.toLocaleLowerCase(),
      );
      if (existing) {
        await openProject(existing);
        props.setOpen(false);
        return;
      }

      const projectId = newProjectId();
      const environmentProviders =
        environment.serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? providers : []);
      const result = await createProject({
        environmentId: environment.environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: resolveDefaultProviderModelSelection(environmentProviders, null),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to add project",
              description: cause instanceof Error ? cause.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      await handleNewThread(scopeProjectRef(environment.environmentId, projectId));
      props.setOpen(false);
    },
    [
      createProject,
      handleNewThread,
      localEnvironments,
      openProject,
      primaryEnvironmentId,
      projects,
      props,
      providers,
    ],
  );

  const groups = useMemo<CommandPaletteGroup[]>(() => {
    const actions: CommandPaletteActionItem[] = [];
    if (currentProjectRef) {
      actions.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new thread", "new chat", "create"],
        title: "New thread",
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.new",
        run: async () => {
          await handleNewThread(currentProjectRef);
        },
      });
    }
    actions.push(
      {
        kind: "action",
        value: "action:file-picker",
        searchTerms: ["go to file", "open file", "find file"],
        title: "Go to file",
        icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        shortcutCommand: "filePicker.toggle",
        run: async () => props.openOverlayMode("files"),
      },
      {
        kind: "action",
        value: "action:content-search",
        searchTerms: ["search project", "find in files", "content search"],
        title: "Search project contents",
        icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        shortcutCommand: "projectSearch.toggle",
        run: async () => props.openOverlayMode("content"),
      },
    );
    for (const environment of localEnvironments) {
      const label = environmentLabel(environment);
      actions.push({
        kind: "action",
        value: `action:add-project:${environment.environmentId}`,
        searchTerms: ["add project", "folder project", "open folder", "directory", label, "wsl"],
        title:
          localEnvironments.length === 1 ? "Add folder project" : `Add folder project on ${label}`,
        description: environment.connection.phase === "connected" ? undefined : "Unavailable",
        disabled: environment.connection.phase !== "connected",
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => addProject(environment),
      });
    }
    for (const environment of environments) {
      const label = environmentLabel(environment);
      actions.push({
        kind: "action",
        value: `action:add-onshape-project:${environment.environmentId}`,
        searchTerms: ["add project", "onshape", "cad", label],
        title:
          environments.length === 1 ? "Add Onshape project" : `Add Onshape project on ${label}`,
        description: environment.connection.phase === "connected" ? undefined : "Unavailable",
        disabled: environment.connection.phase !== "connected",
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => setOnshapeEnvironmentId(environment.environmentId),
      });
    }
    actions.push({
      kind: "action",
      value: "action:settings",
      searchTerms: ["settings", "preferences", "keybindings", "appearance"],
      title: "Open settings",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => navigate({ to: "/settings/general" }),
    });

    const projectItems: CommandPaletteActionItem[] = projects.flatMap((project) => [
      {
        kind: "action" as const,
        value: `project:${project.environmentId}:${project.id}`,
        searchTerms: [
          project.title,
          project.onshapeSource ? "onshape cad" : project.workspaceRoot,
          "project",
        ],
        title: project.title,
        description: project.onshapeSource ? "Onshape project" : project.workspaceRoot,
        icon: projectIcon(project),
        run: async () => openProject(project),
      },
      {
        kind: "action" as const,
        value: `project-settings:${project.environmentId}:${project.id}`,
        searchTerms: [
          "project settings",
          project.title,
          project.onshapeSource ? "onshape connection cad" : project.workspaceRoot,
        ],
        title: `Project settings for ${project.title}`,
        description: project.onshapeSource ? "Onshape project" : project.workspaceRoot,
        icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
        run: async () =>
          navigate({
            to: "/projects/$projectKey",
            params: {
              projectKey: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
            },
          }),
      },
      {
        kind: "action" as const,
        value: `new-thread-in:${project.environmentId}:${project.id}`,
        searchTerms: [
          "new thread in",
          project.title,
          project.onshapeSource ? "onshape cad" : project.workspaceRoot,
        ],
        title: `New thread in ${project.title}`,
        description: project.onshapeSource ? "Onshape project" : project.workspaceRoot,
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await handleNewThread(scopeProjectRef(project.environmentId, project.id));
        },
      },
    ]);

    const recentItems: CommandPaletteActionItem[] = threads
      .filter((thread) => thread.archivedAt === null)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12)
      .map((thread) => {
        const project = projects.find(
          (candidate) =>
            candidate.id === thread.projectId && candidate.environmentId === thread.environmentId,
        );
        return {
          kind: "action" as const,
          value: `thread:${thread.environmentId}:${thread.id}`,
          searchTerms: [thread.title, project?.title ?? "", "thread"],
          title: thread.title,
          description: project?.title,
          timestamp: formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt),
          icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
          run: async () => openThread(thread),
        };
      });

    return [
      { value: "actions", label: "Actions", items: actions },
      ...(projectItems.length > 0
        ? [{ value: "projects", label: "Projects", items: projectItems }]
        : []),
      ...(recentItems.length > 0
        ? [{ value: "recent", label: "Recent threads", items: recentItems }]
        : []),
    ];
  }, [
    addProject,
    currentProjectRef,
    environmentLabel,
    environments,
    handleNewThread,
    localEnvironments,
    navigate,
    openProject,
    openThread,
    projects,
    props,
    threads,
  ]);

  useLayoutEffect(() => {
    if (!props.openIntent) return;
    setQuery(props.openIntent.kind === "add-project" ? "add project" : "new thread in");
    setHighlightedItemValue(null);
    props.clearOpenIntent();
  }, [props]);

  useEffect(() => {
    setQuery("");
    setHighlightedItemValue(null);
  }, [threadRouteKey]);

  const rootGroups = deferredQuery.startsWith(">") ? groups.slice(0, 1) : groups;
  const displayedGroups = filterCommandPaletteGroups(rootGroups, deferredQuery);
  const executeItem = useCallback(
    (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => {
      if (item.kind !== "action" || item.disabled) return;
      void item.run().finally(() => {
        if (!item.keepOpen) props.setOpen(false);
      });
    },
    [props],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || !highlightedItemValue) return;
    const item = displayedGroups
      .flatMap((group) => group.items)
      .find((candidate) => candidate.value === highlightedItemValue);
    if (!item) return;
    event.preventDefault();
    executeItem(item);
  };

  const onshapeEnvironment = environments.find(
    (environment) => environment.environmentId === onshapeEnvironmentId,
  );
  if (onshapeEnvironment) {
    return (
      <OnshapeProjectCreateForm
        key={onshapeEnvironment.environmentId}
        environmentId={onshapeEnvironment.environmentId}
        environmentLabel={environmentLabel(onshapeEnvironment)}
        connected={onshapeEnvironment.connection.phase === "connected"}
        onCancel={() => setOnshapeEnvironmentId(null)}
        onConfigure={() => {
          props.setOpen(false);
          void navigate({
            to: "/settings/integrations",
            search: { environmentId: onshapeEnvironment.environmentId },
          });
        }}
        onCreate={async (input) => {
          props.setBusy(true);
          try {
            const projectId = newProjectId();
            const result = await createOnshapeProject({
              environmentId: onshapeEnvironment.environmentId,
              input: {
                ...input,
                projectId,
                defaultModelSelection: resolveDefaultProviderModelSelection(
                  onshapeEnvironment.serverConfig?.providers ?? [],
                  null,
                ),
              },
            });
            if (result._tag === "Failure") {
              if (isAtomCommandInterrupted(result))
                return "Project creation was interrupted. Check your projects before trying again.";
              const cause = squashAtomCommandFailure(result);
              return cause instanceof Error
                ? cause.message
                : "Could not create the Onshape project.";
            }
            try {
              await handleNewThread(
                scopeProjectRef(onshapeEnvironment.environmentId, result.value.projectId),
              );
            } catch {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Project created",
                  description:
                    "Could not open a thread. Open the project from the sidebar to try again.",
                }),
              );
            }
            props.setBusy(false);
            props.setOpen(false);
            return null;
          } finally {
            props.setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <CommandPaletteContent
      aria-label="Command palette"
      footerActionLabel="Open"
      inputProps={{
        placeholder: "Search commands, projects, and threads",
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      onItemHighlighted={(value) =>
        setHighlightedItemValue(typeof value === "string" ? value : null)
      }
      onValueChange={(value) => {
        setQuery(value);
        setHighlightedItemValue(null);
      }}
      panelClassName="max-h-[min(28rem,70vh)]"
      value={query}
    >
      <CommandPaletteResults
        groups={displayedGroups}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={deferredQuery.startsWith(">")}
        keybindings={keybindings}
        onExecuteItem={executeItem}
      />
    </CommandPaletteContent>
  );
}
