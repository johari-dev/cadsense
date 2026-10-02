import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@cadsense/client-runtime/environment";
import { squashAtomCommandFailure } from "@cadsense/client-runtime/state/runtime";
import { FileBoxIcon, FolderPlusIcon } from "lucide-react";
import type { ProjectId } from "@cadsense/contracts";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { readLocalApi } from "../localApi";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { onshapeProjectEnvironment } from "../state/onshapeProjects";
import { localCadProjectEnvironment } from "../state/localCadProjects";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { OnshapeProjectCreateForm } from "./OnshapeProjectCreateForm";
import { LocalCadProjectCreateForm } from "./LocalCadProjectCreateForm";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";

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
  // Folder pickers are native, so folder-based projects need the desktop app's local backend.
  const canPickFolder =
    !!environment &&
    environment.connection.phase === "connected" &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      desktopLocalBackendId(environment.entry.target) !== null);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open !== "add-project" || busyRef.current) return;
        setKind(null);
        setSelectedId(null);
        setError(null);
        setOpen(true);
      }),
    [],
  );

  async function pickFolder() {
    const api = readLocalApi();
    if (!api || !environment) return null;
    const backendId = desktopLocalBackendId(environment.entry.target);
    return api.dialogs.pickFolder({
      ...(backendId ? { targetEnvironmentId: backendId } : {}),
      initialPath:
        environment.serverConfig?.settings?.addProjectBaseDirectory ||
        (environment.serverConfig?.environment.platform.os === "windows" ? "C:\\" : "~/"),
    });
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
      <DialogPopup aria-label="Add project" className="p-0">
        <DialogTitle className="px-5 pt-5">Add project</DialogTitle>
        {environments.length > 1 && (
          <label className="mx-5 mt-4 block text-sm">
            Environment
            <select
              aria-label="Project environment"
              disabled={busy}
              value={environment?.environmentId ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              className="mt-2 w-full rounded-md border bg-background p-2"
            >
              {environments.map((item) => (
                <option key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
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
                to: "/settings/integrations",
                search: { environmentId: environment.environmentId },
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
            pickFolder={isElectron && canPickFolder ? pickFolder : null}
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
                // The server reuses an existing project for this folder, which may have chats.
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
          <div className="grid gap-3 p-5">
            <Button
              variant="outline"
              className="h-auto justify-start gap-3 px-4 py-4"
              disabled={busy || !canPickFolder}
              onClick={() => void addFolder()}
            >
              <FolderPlusIcon className="size-5" />
              Folder project
            </Button>
            <Button
              variant="outline"
              className="h-auto justify-start gap-3 px-4 py-4"
              disabled={busy || !environment || environment.connection.phase !== "connected"}
              onClick={() => setKind("local-cad")}
            >
              <FileBoxIcon className="size-5" />
              Local CAD file
            </Button>
            <Button
              variant="outline"
              className="h-auto justify-start gap-3 px-4 py-4"
              disabled={busy || !environment || environment.connection.phase !== "connected"}
              onClick={() => setKind("onshape")}
            >
              <img src="/onshape.svg" alt="" className="size-5" />
              Onshape project
            </Button>
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
