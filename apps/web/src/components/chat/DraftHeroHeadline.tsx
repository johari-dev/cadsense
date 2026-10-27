import { scopedProjectKey, scopeProjectRef } from "@cadsense/client-runtime/environment";
import type { ScopedProjectRef } from "@cadsense/contracts";
import {
  CaretDownIcon,
  CubeIcon,
  FolderPlusIcon,
  ScanIcon,
  StackIcon,
  PencilSimpleIcon,
} from "~/lib/icons";
import { useCallback, useMemo } from "react";

import { Button } from "../ui/button";
import { singleCadModelName } from "~/cad/cadModelName";
import { modelThumbnailKey, useModelThumbnails } from "~/cad/modelThumbnails";
import type { Project } from "~/types";
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

/** Prompts the hero offers as one-click starts. The first is the suggested one. */
const STARTING_TASKS = [
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
] as const;

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly onChooseTask: (prompt: string) => void;
}

/**
 * The draft hero above the composer: a headline whose project name opens a project
 * switcher, a one-line lede, and the starting tasks. Other projects live in the sidebar
 * and the switcher, so the hero does not repeat them.
 */
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
  const activeProject = projectByKey.get(activeProjectKey);

  const projectSelector = canChooseProject ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label={activeProjectTitle ? "Change project" : "Choose a project"}
              className="pointer-events-auto -mx-1.5 inline-flex max-w-80 cursor-pointer items-baseline gap-1 rounded-lg px-1.5 align-baseline text-foreground transition-colors hover:bg-accent data-popup-open:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <span className="min-w-0 truncate">{activeProjectTitle ?? "Choose a project"}</span>
          <CaretDownIcon className="size-5 shrink-0 self-center text-muted-foreground" />
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
      className="pointer-events-auto inline cursor-pointer rounded-lg px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      Add a project
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-3xl text-center">
      {activeProject?.cad?.enabled ? <ProjectModelPreview project={activeProject} /> : null}
      <h1 className="font-semibold text-[26px] text-foreground leading-8 tracking-tight">
        {activeProjectTitle ? (
          projectSelector
        ) : canChooseProject ? (
          <>{projectSelector} to begin</>
        ) : (
          <>Start with a project</>
        )}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Review the model, inspect parts, or plan a change.
      </p>
      {activeProjectTitle ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5">
          {STARTING_TASKS.map(({ label, icon: Icon, prompt }, index) => (
            <Button
              key={label}
              // The first task is the suggested start; the others stay quiet beside it.
              variant={index === 0 ? "default" : "ghost-muted"}
              size="sm"
              onClick={() => onChooseTask(prompt)}
              className="pointer-events-auto"
            >
              <Icon className="size-4" />
              {label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="mt-4">{projectSelector}</div>
      )}
    </div>
  );
}

/**
 * The active project's model above the headline: its captured thumbnail once the CAD panel
 * has rendered it, otherwise a viewport-colored tile with the model's name. Never loads CAD
 * just to draw it.
 */
function ProjectModelPreview({ project }: { readonly project: Project }) {
  const snapshotId = project.cad?.roots.find((root) => root.current)?.current?.snapshotId;
  const thumbnail = useModelThumbnails((state) =>
    snapshotId ? state.images[modelThumbnailKey(project.environmentId, snapshotId)] : undefined,
  );
  const modelName = singleCadModelName(project.cad);

  return (
    <div
      aria-hidden
      className="mx-auto mb-6 flex h-33 w-44 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-border bg-(--cad-viewport-background) shadow-sm"
    >
      {thumbnail ? (
        // Thumbnails are square on the viewport color, so `contain` blends into the tile.
        <img src={thumbnail} alt="" className="size-full object-contain" />
      ) : (
        <>
          <CubeIcon className="size-8 text-tertiary-foreground" weight="thin" />
          {modelName ? (
            <span className="max-w-full truncate px-3 text-muted-foreground text-xs">
              {modelName}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
