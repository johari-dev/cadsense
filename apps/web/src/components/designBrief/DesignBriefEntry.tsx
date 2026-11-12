import { scopeProjectRef, scopeThreadRef } from "@cadsense/client-runtime/environment";
import type { ScopedThreadRef } from "@cadsense/contracts";
import { useState } from "react";

import { useActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { FileIcon } from "~/lib/icons";
import type { Project } from "~/types";

import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { useDesignBrief } from "./useDesignBrief";

/*
 * Entry points to a CAD project's design brief. Each opens the brief in the right panel's file
 * editor, creating it from the template when missing:
 * - project settings always show a row;
 * - the new-thread screen shows a card while the brief is missing or not filled in;
 * - the CAD panel's title row shows a button once it is filled in.
 */

const SETTINGS_DESCRIPTION = {
  missing:
    "Tell reviews what this mechanism does, what moves, and what is a stand-in. Reviews read it as your intent.",
  template: "Only the template's questions so far. Reviews skip it until you answer one.",
  filled: "Reviews read it as your intent before they look at the model.",
} as const;

/** The project settings row. Opens the brief in a new thread, since settings have no panel. */
export function DesignBriefSettings({ project }: { readonly project: Project }) {
  const brief = useDesignBrief(project);
  const handleNewThread = useNewThreadHandler();
  const [opening, setOpening] = useState(false);
  const openBrief = async () => {
    setOpening(true);
    try {
      const thread = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
      if (thread) await brief.open(scopeThreadRef(project.environmentId, thread.threadId));
    } finally {
      setOpening(false);
    }
  };
  return (
    <SettingsSection title="Design brief">
      <SettingsRow
        title={brief.relativePath}
        description={brief.state ? SETTINGS_DESCRIPTION[brief.state] : SETTINGS_DESCRIPTION.filled}
        control={
          <Button
            variant="outline"
            type="button"
            disabled={brief.state === null || opening}
            onClick={() => void openBrief()}
          >
            <FileIcon />
            {brief.state === "missing" ? "Create" : "Edit"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

/** The new-thread card, shown until the brief has an answer in it. */
export function DesignBriefCard({ project }: { readonly project: Project }) {
  const brief = useDesignBrief(project);
  const target = useActiveProjectTarget();
  if (!target || brief.state === null || brief.state === "filled") return null;
  const missing = brief.state === "missing";
  return (
    <div className="pointer-events-auto mx-auto mt-5 flex w-full max-w-md items-center gap-3 rounded-xl border border-border px-4 py-3 text-left">
      <FileIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground text-sm">Design brief</p>
        <p className="text-muted-foreground text-xs">
          {missing
            ? "Tell reviews what this does, what moves, and what is a stand-in."
            : "Answer the template's questions so reviews can use them."}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void brief.open(target.threadRef)}>
        {missing ? "Write brief" : "Finish brief"}
      </Button>
    </div>
  );
}

/** The CAD panel's title-row button, shown once the brief is filled in. */
export function DesignBriefTitleButton({
  project,
  threadRef,
}: {
  readonly project: Project;
  readonly threadRef: ScopedThreadRef;
}) {
  const brief = useDesignBrief(project);
  if (brief.state !== "filled") return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      className="ml-auto shrink-0"
      aria-label={`Open design brief (${brief.relativePath})`}
      onClick={() => void brief.open(threadRef)}
    >
      <FileIcon />
      Brief
    </Button>
  );
}
