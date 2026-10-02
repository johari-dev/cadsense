import { scopedProjectKey, scopeProjectRef } from "@cadsense/client-runtime/environment";
import type { ScopedProjectRef } from "@cadsense/contracts";
import {
  CubeIcon,
  FolderPlusIcon,
  ScanIcon,
  StackIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { useCallback, useMemo } from "react";

import { ProjectFavicon } from "../ProjectFavicon";
import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects } from "~/state/entities";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly onChooseTask: (prompt: string) => void;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
  onChooseTask,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const orderedProjects = useMemo(
    () => [...projects].toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );
  const activeProjectKey = activeProjectRef ? scopedProjectKey(activeProjectRef) : "";
  const projectByKey = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
          project,
        ]),
      ),
    [orderedProjects],
  );
  const canChooseProject = orderedProjects.length > 0;

  const projectSelector = canChooseProject ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label={activeProjectTitle ? "Change project" : "Choose a project"}
              className="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {activeProjectTitle ?? "Choose a project"}
        </TooltipTrigger>
        {activeProjectTitle ? <TooltipPopup side="top">{activeProjectTitle}</TooltipPopup> : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            const project = projectByKey.get(String(value));
            if (!project || value === activeProjectKey) return;
            void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
              replace: true,
              carryComposerContent: true,
            });
          }}
        >
          {orderedProjects.map((project) => {
            const key = scopedProjectKey({
              environmentId: project.environmentId,
              projectId: project.id,
            });
            return (
              <MenuRadioItem key={key} value={key} closeOnClick>
                <span className="block min-w-0 truncate">{project.title}</span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      Add a project
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-3xl text-center">
      <div className="mb-4 flex items-center justify-center gap-2 text-primary">
        <CubeIcon size={24} weight="duotone" />
        <span className="text-[10px] font-medium uppercase tracking-[0.2em]">Design workspace</span>
      </div>
      <h1 className="font-medium text-2xl text-foreground tracking-tight sm:text-3xl">
        {activeProjectTitle ? (
          <>Explore {projectSelector}</>
        ) : canChooseProject ? (
          <>{projectSelector} to begin</>
        ) : (
          <>Start with a project</>
        )}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Inspect the details. Work through the next change.
      </p>
      {activeProjectTitle ? (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {[
            {
              label: "Review the design",
              icon: ScanIcon,
              prompt:
                "Review this design and identify details that need attention. Explain your findings and reference the relevant parts.",
            },
            {
              label: "Explore the assembly",
              icon: StackIcon,
              prompt:
                "Walk me through this assembly and explain how its main components fit and work together.",
            },
            {
              label: "Plan a change",
              icon: PencilSimpleIcon,
              prompt:
                "Help me plan a design change. Start by asking what I want to change and what constraints matter.",
            },
          ].map(({ label, icon: Icon, prompt }) => (
            <button
              key={label}
              type="button"
              onClick={() => onChooseTask(prompt)}
              className="pointer-events-auto flex items-center gap-2 rounded border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon className="size-4 text-primary" />
              {label}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-4">{projectSelector}</div>
      )}
      {orderedProjects.length > 1 ? (
        <div className="mx-auto mt-5 flex max-w-lg flex-wrap justify-center gap-2">
          {orderedProjects
            .filter(
              (project) =>
                scopedProjectKey({
                  environmentId: project.environmentId,
                  projectId: project.id,
                }) !== activeProjectKey,
            )
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 3)
            .map((project) => (
              <button
                key={`${project.environmentId}:${project.id}`}
                type="button"
                aria-label={`Open project ${project.title}`}
                onClick={() =>
                  void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
                    replace: true,
                    carryComposerContent: true,
                  })
                }
                className="pointer-events-auto flex max-w-52 items-center gap-2 rounded border border-border px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-card focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ProjectFavicon
                  environmentId={project.environmentId}
                  cwd={project.workspaceRoot}
                  onshapeSource={project.onshapeSource}
                  cadSnapshotId={
                    project.cad?.roots.find((root) => root.current)?.current?.snapshotId
                  }
                  className="size-8"
                />
                <span className="min-w-0">
                  <span className="block text-[10px]">Recent project</span>
                  <span className="block truncate text-foreground">{project.title}</span>
                </span>
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}
