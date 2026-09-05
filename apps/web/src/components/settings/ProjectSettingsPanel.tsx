import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@cadsense/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cadsense/client-runtime/state/runtime";
import type { ModelSelection, ProviderDriverKind } from "@cadsense/contracts";
import { createModelSelection } from "@cadsense/shared/model";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { FolderOpenIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { usePrimarySettings } from "../../hooks/useSettings";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Project } from "../../types";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { OnshapeProjectSettings } from "./OnshapeProjectSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

function projectKey(project: Project): string {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

function useSettingsProject(key: string): Project | null {
  const projects = useProjects();
  return projects.find((project) => projectKey(project) === key) ?? null;
}

export function ProjectSettingsPage({ projectKey: selectedProjectKey }: { projectKey: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const project = useSettingsProject(selectedProjectKey);
  const close = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Project settings breadcrumb">
            <WorkspaceBreadcrumbItem>Projects</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem>
              {project?.title ?? "Unavailable project"}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {project ? (
          <ProjectSettingsPanel key={projectKey(project)} project={project} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            This project is no longer available.
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

export function ProjectSettingsPanel({ project }: { project: Project }) {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const openInFileManager = useAtomCommand(shellEnvironment.openInFileManager, {
    reportFailure: false,
  });
  const nameEditedRef = useRef(false);

  const reportFailure = useCallback(
    (title: string, result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [],
  );

  const update = useCallback(
    async (input: Partial<Pick<Project, "title" | "defaultModelSelection">>) => {
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: project.environmentId,
          input: { projectId: project.id, ...input },
        }),
        () => undefined,
      );
      reportFailure("Failed to update project", result);
      return result;
    },
    [project.environmentId, project.id, reportFailure, updateProject],
  );

  const storedSelection = project.defaultModelSelection;
  const resolvedSelection = resolveDefaultProviderModelSelection(serverProviders, storedSelection);
  const resolvedInstanceId = resolvedSelection?.instanceId ?? null;
  const resolvedModel = resolvedSelection?.model ?? null;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, serverProviders, resolvedInstanceId, resolvedModel),
    [resolvedInstanceId, resolvedModel, serverProviders, settings],
  );
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === resolvedInstanceId);
  const setDefaultModel = useCallback(
    (selection: ModelSelection | null) => void update({ defaultModelSelection: selection }),
    [update],
  );

  const removeProject = useCallback(async () => {
    const api = readLocalApi();
    if (!api) return;
    const projectThreads = threads.filter(
      (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
    );
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          `Remove project "${project.title}"?`,
          ...(project.onshapeSource ? [] : [`Path: ${project.workspaceRoot}`]),
          ...(projectThreads.length > 0
            ? [
                `This permanently deletes ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}.`,
              ]
            : []),
          "Files on disk are not touched.",
          "This action cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;

    const result = mapAtomCommandResult(
      await deleteProject({
        environmentId: project.environmentId,
        input: { projectId: project.id, ...(projectThreads.length > 0 ? { force: true } : {}) },
      }),
      () => undefined,
    );
    if (result._tag === "Failure") {
      reportFailure("Failed to remove project", result);
      return;
    }

    const ref = scopeProjectRef(project.environmentId, project.id);
    releaseProjectDraftUploads(
      ref,
      projectThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
    );
    const drafts = useComposerDraftStore.getState();
    const projectDraft = drafts.getDraftThreadByProjectRef(ref);
    if (projectDraft) drafts.clearDraftThread(projectDraft.draftId);
    drafts.clearProjectDraftThreadId(ref);
    void navigate({ to: "/", replace: true });
  }, [deleteProject, navigate, project, reportFailure, threads]);

  const showInExplorer = useCallback(async () => {
    const result = await openInFileManager({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    });
    reportFailure("Unable to open Explorer", result);
  }, [openInFileManager, project.environmentId, project.workspaceRoot, reportFailure]);

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection title="Project" icon={<SettingsIcon className="size-4" />}>
          <SettingsRow
            title="Name"
            description="Shown in the sidebar and thread list."
            control={
              <Input
                key={`${projectKey(project)}:${project.title}`}
                className="w-full sm:w-64"
                aria-label="Project name"
                defaultValue={project.title}
                onChange={() => {
                  nameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  if (!nameEditedRef.current) return;
                  nameEditedRef.current = false;
                  const title = event.currentTarget.value.trim();
                  if (!title) {
                    event.currentTarget.value = project.title;
                    toastManager.add({ type: "warning", title: "Project name cannot be empty" });
                    return;
                  }
                  void update({ title });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          {!project.onshapeSource && (
            <SettingsRow
              title="Folder"
              description={project.workspaceRoot}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  onClick={() => void showInExplorer()}
                >
                  <FolderOpenIcon />
                  Open in Explorer
                </Button>
              }
            />
          )}
        </SettingsSection>

        {project.onshapeSource && (
          <OnshapeProjectSettings project={project} source={project.onshapeSource} />
        )}

        <SettingsSection title="New threads">
          <SettingsRow
            title="Model"
            description="New threads in this project start with this model."
            resetAction={
              storedSelection !== null ? (
                <SettingResetButton
                  label="project default model"
                  onClick={() => setDefaultModel(null)}
                />
              ) : null
            }
            control={
              resolvedSelection && activeEntry ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={resolvedSelection.instanceId}
                    model={resolvedSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    onInstanceModelChange={(instanceId, model) =>
                      setDefaultModel(createModelSelection(instanceId, model))
                    }
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind as ProviderDriverKind}
                    models={activeEntry.models}
                    model={resolvedSelection.model}
                    prompt=""
                    onPromptChange={() => undefined}
                    modelOptions={resolvedSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    triggerVariant="outline"
                    onModelOptionsChange={(options) =>
                      setDefaultModel(
                        createModelSelection(
                          resolvedSelection.instanceId,
                          resolvedSelection.model,
                          options,
                        ),
                      )
                    }
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
        </SettingsSection>

        <SettingsSection title="Danger zone">
          <SettingsRow
            title="Remove project"
            description="Deletes this project's threads without touching its files."
            control={
              <Button variant="destructive-outline" size="sm" onClick={() => void removeProject()}>
                <Trash2Icon />
                Remove project
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    </>
  );
}
