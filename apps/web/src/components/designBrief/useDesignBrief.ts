import {
  CADSENSE_DESIGN_BRIEF_DEFAULT_PATH,
  CADSENSE_DESIGN_BRIEF_TEMPLATE,
  CADSENSE_PROJECT_FILE_NAME,
  type ScopedThreadRef,
} from "@cadsense/contracts";
import { parseCadsenseProjectFile } from "@cadsense/shared/cadsenseProjectFile";
import { designBriefState, type DesignBriefState } from "@cadsense/shared/designBrief";
import { useCallback } from "react";

import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "~/components/files/projectFilesQueryState";
import { useRightPanelStore } from "~/rightPanelStore";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import type { Project } from "~/types";

export interface DesignBrief {
  /** `null` until the project file and the brief have been read. */
  readonly state: DesignBriefState | null;
  /** Workspace-relative path: `designBrief` from cadsense.json, else DESIGN.md, as the server reads it. */
  readonly relativePath: string;
  /** Opens the brief in the thread's right panel, without the file explorer, writing the template first when there is none. */
  readonly open: (threadRef: ScopedThreadRef) => Promise<boolean>;
}

/**
 * A project's design brief for the entry points in DesignBriefEntry.tsx. It reads through the
 * same file query the editor saves into, so the state follows edits as the student types.
 */
export function useDesignBrief(project: Project): DesignBrief {
  const { environmentId, workspaceRoot: cwd } = project;
  const projectFile = useProjectFileQuery(environmentId, cwd, CADSENSE_PROJECT_FILE_NAME);
  // A missing or unreadable cadsense.json means the default path, as on the server.
  const projectFileSettled = projectFile.data !== null || projectFile.error !== null;
  const relativePath =
    (projectFile.data && parseCadsenseProjectFile(projectFile.data.contents)?.designBrief) ??
    CADSENSE_DESIGN_BRIEF_DEFAULT_PATH;
  const brief = useProjectFileQuery(environmentId, cwd, relativePath, projectFileSettled);
  const state: DesignBriefState | null = brief.data
    ? designBriefState(brief.data.contents)
    : projectFileSettled && brief.error !== null
      ? designBriefState(null)
      : null;
  const writeFile = useAtomCommand(projectEnvironment.writeFile, "Create design brief");

  const open = useCallback(
    async (threadRef: ScopedThreadRef) => {
      if (state === "missing") {
        const contents = CADSENSE_DESIGN_BRIEF_TEMPLATE;
        const result = await writeFile({ environmentId, input: { cwd, relativePath, contents } });
        if (result._tag === "Failure") return false;
        // Same handoff the editor uses after a save, so the panel opens on the new file.
        setProjectFileQueryData(environmentId, cwd, relativePath, contents);
        confirmProjectFileQueryData(environmentId, cwd, relativePath, contents);
      }
      useRightPanelStore.getState().openFile(threadRef, relativePath, undefined, {
        hideExplorer: true,
      });
      return true;
    },
    [cwd, environmentId, relativePath, state, writeFile],
  );

  return { state, relativePath, open };
}
