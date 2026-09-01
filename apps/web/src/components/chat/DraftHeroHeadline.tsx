import { scopedProjectKey, scopeProjectRef } from "@cadsense/client-runtime/environment";
import type { ScopedProjectRef } from "@cadsense/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

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
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
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
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {activeProjectTitle ? (
        <>What should we build in {projectSelector}?</>
      ) : canChooseProject ? (
        <>{projectSelector} to start</>
      ) : (
        <>Add a project to start</>
      )}
    </h1>
  );
}
