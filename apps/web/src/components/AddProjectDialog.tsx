import { settingsLocation } from "./settings/settingsLocation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@cadsense/client-runtime/environment";
import { squashAtomCommandFailure } from "@cadsense/client-runtime/state/runtime";
import type { ProjectId } from "@cadsense/contracts";
import { CaretRightIcon, CubeIcon, FolderIcon } from "~/lib/icons";
import { CAD_FILE_FILTERS } from "../cad/CadFilePrompt";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { readLocalApi } from "../localApi";
import { findProjectByPath, inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { localCadProjectEnvironment } from "../state/localCadProjects";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { OnshapeProjectCreateForm } from "./OnshapeProjectCreateForm";
import { LocalCadProjectCreateForm } from "./LocalCadProjectCreateForm";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { DialogRows } from "./ui/dialog-rows";

/** Native folder and file pickers browse the desktop app's local backend, so they need it. */
function canPickNativelyOn(environment: EnvironmentPresentation | undefined) {
  return (
    !!environment &&
    environment.connection.phase === "connected" &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      desktopLocalBackendId(environment.entry.target) !== null)
  );
}

/** Where the native pickers open, and which backend they browse, for `environment`. */
function pickerOptions(environment: EnvironmentPresentation) {
  const backendId = desktopLocalBackendId(environment.entry.target);
  return {
    ...(backendId ? { targetEnvironmentId: backendId } : {}),
    initialPath:
      environment.serverConfig?.settings?.addProjectBaseDirectory ||
      (environment.serverConfig?.environment.platform.os === "windows" ? "C:\\" : "~/"),
  };
}

/**
 * The desktop app's file dialog for picking a CAD file on `environment`'s machine, or null where
 * there is none: a browser, or a remote or disconnected backend. The picker resolves to the chosen
 * path, or null when cancelled.
 */
export function nativeCadFilePicker(
  environment: EnvironmentPresentation | undefined,
): (() => Promise<string | null>) | null {
  if (!isElectron || !environment || !canPickNativelyOn(environment)) return null;
  return async () =>
    (await readLocalApi()?.dialogs.pickFile({
      ...pickerOptions(environment),
      filters: CAD_FILE_FILTERS,
    })) ?? null;
}

export function AddProjectDialog() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"onshape" | "local-cad" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environment = environments.find((item) => item.environmentId === (selectedId ?? primaryId));
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const createOnshapeProject = useAtomCommand(onshapeProjectEnvironment.create, {
    reportFailure: false,
  });
  const createLocalCadProject = useAtomCommand(localCadProjectEnvironment.create, {
    reportFailure: false,
  });
  const canPickNatively = canPickNativelyOn(environment);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open !== "add-project" || busyRef.current) return;
        setKind(detail.kind ?? null);
        setSelectedId(null);
        setError(null);
        setOpen(true);
      }),
    [],
  );

  async function pickFolder() {
    const api = readLocalApi();
    return api && environment ? api.dialogs.pickFolder(pickerOptions(environment)) : null;
  }

  /** Opens the project's most recent chat, or a new one when it has none. */
  async function openProject(projectId: ProjectId) {
    if (!environment) return;
    const latest = threads
      .filter(
        (thread) =>
          thread.environmentId === environment.environmentId &&
          thread.projectId === projectId &&
          thread.archivedAt === null,
      )
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest)
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environment.environmentId, latest.id)),
      });
    else await handleNewThread(scopeProjectRef(environment.environmentId, projectId));
  }

  async function addFolder() {
    if (!environment || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const cwd = await pickFolder();
      if (!cwd) return;
      const normalize = (path: string) =>
        environment.serverConfig?.environment.platform.os === "windows" ? path.toLowerCase() : path;
      const existing = projects.find(
        (project) =>
          project.environmentId === environment.environmentId &&
          normalize(project.workspaceRoot) === normalize(cwd),
      );
      const projectId = existing?.id ?? newProjectId();
      if (!existing) {
        const result = await createProject({
          environmentId: environment.environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(cwd),
            workspaceRoot: cwd,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: resolveDefaultProviderModelSelection(
              environment.serverConfig?.providers ?? [],
              null,
            ),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      await openProject(projectId);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add project.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (busyRef.current) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <DialogPopup aria-label="Add project">
        <DialogHeader className="flex-row items-center gap-3">
          <DialogTitle className="flex-1">
            {kind === "onshape"
              ? "New Onshape project"
              : kind === "local-cad"
                ? "New CAD project"
                : "Add project"}
          </DialogTitle>
          {environments.length > 1 && (
            <select
              aria-label="Project environment"
              disabled={busy}
              value={environment?.environmentId ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              className="h-7 max-w-40 truncate rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground"
            >
              {environments.map((item) => (
                <option key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
        </DialogHeader>
        {kind === "onshape" && environment ? (
          <OnshapeProjectCreateForm
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
            connected={environment.connection.phase === "connected"}
            onCancel={() => setKind(null)}
            onConfigure={() => {
              setOpen(false);
              void navigate({
                ...settingsLocation("integrations", environment.environmentId),
              });
            }}
            onCreate={async (input) => {
              busyRef.current = true;
              setBusy(true);
              try {
                const result = await createOnshapeProject({
                  environmentId: environment.environmentId,
                  input: {
                    ...input,
                    projectId: newProjectId(),
                    defaultModelSelection: resolveDefaultProviderModelSelection(
                      environment.serverConfig?.providers ?? [],
                      null,
                    ),
                  },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                await handleNewThread(
                  scopeProjectRef(environment.environmentId, result.value.projectId),
                );
                setOpen(false);
                return null;
              } catch (cause) {
                return cause instanceof Error ? cause.message : "Unable to add Onshape project.";
              } finally {
                busyRef.current = false;
                setBusy(false);
              }
            }}
          />
        ) : kind === "local-cad" && environment ? (
          <LocalCadProjectCreateForm
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
            connected={environment.connection.phase === "connected"}
            pickFile={nativeCadFilePicker(environment)}
            folderHasProject={(workspaceRoot) =>
              findProjectByPath(
                projects.filter((project) => project.environmentId === environment.environmentId),
                workspaceRoot,
              ) !== undefined
            }
            onCancel={() => setKind(null)}
            onCreate={async (input) => {
              busyRef.current = true;
              setBusy(true);
              try {
                const result = await createLocalCadProject({
                  environmentId: environment.environmentId,
                  input: {
                    ...input,
                    projectId: newProjectId(),
                    defaultModelSelection: resolveDefaultProviderModelSelection(
                      environment.serverConfig?.providers ?? [],
                      null,
                    ),
                  },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                // The server reuses the project that already reviews this file, which may have chats.
                await openProject(result.value.projectId);
                setOpen(false);
                return null;
              } catch (cause) {
                return cause instanceof Error ? cause.message : "Unable to add local CAD project.";
              } finally {
                busyRef.current = false;
                setBusy(false);
              }
            }}
          />
        ) : (
          <div className="grid gap-3 px-5 pb-5">
            <DialogRows>
              <ProjectKindRow
                icon={<CubeIcon className="size-4" />}
                label="CAD file"
                detail="A STEP, IGES or SolidWorks file"
                disabled={busy || !environment || environment.connection.phase !== "connected"}
                onClick={() => setKind("local-cad")}
              />
              <ProjectKindRow
                icon={<img src="/onshape.svg" alt="" className="size-4" />}
                label="Onshape document"
                detail="Paste a link. Uses no API requests."
                disabled={busy || !environment || environment.connection.phase !== "connected"}
                onClick={() => setKind("onshape")}
              />
              <ProjectKindRow
                icon={<FolderIcon className="size-4" />}
                label="Folder"
                detail={
                  canPickNatively ? "Chat about files, with no CAD import" : "Needs the desktop app"
                }
                disabled={busy || !canPickNatively}
                onClick={() => void addFolder()}
              />
            </DialogRows>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}

/** One kind of project in the add-project chooser: an icon tile, a name, and one line on what it is. */
function ProjectKindRow(props: {
  icon: ReactNode;
  label: string;
  detail: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent">
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="block text-xs text-muted-foreground">{props.detail}</span>
      </span>
      <CaretRightIcon className="size-4 shrink-0 text-tertiary-foreground" />
    </button>
  );
}
