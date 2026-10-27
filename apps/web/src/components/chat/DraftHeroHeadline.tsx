import { scopedProjectKey, scopeProjectRef } from "@cadsense/client-runtime/environment";
import type { ScopedProjectRef } from "@cadsense/contracts";
import {
  CaretDownIcon,
  FolderPlusIcon,
  ScanIcon,
  StackIcon,
  PencilSimpleIcon,
} from "~/lib/icons";
import { useCallback, useMemo } from "react";

import { Button } from "../ui/button";
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
