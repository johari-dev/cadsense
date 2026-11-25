import { scopeProjectRef } from "@cadsense/client-runtime/environment";
import type {
  CadBriefProposalCard,
  CadBriefProposalOutcome,
  ScopedThreadRef,
} from "@cadsense/contracts";
import { useState } from "react";

import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { CheckIcon, FileIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { cadPanelEnvironment } from "~/state/cadPanel";
import { useProject, useThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";

/*
 * An agent's proposal to change the design brief, shown under its reply ("Agent proposals" in
 * apps/server/src/cad/CadDesignBriefSpec.md). The server checked that each added line quotes the
 * student; the card shows that quote beside the line so the student can see it is their own claim.
 */
export function DesignBriefProposalCard({
  card,
  outcome,
  threadRef,
}: {
  readonly card: CadBriefProposalCard;
  /** The student's decision, or null while the proposal is open. */
  readonly outcome: CadBriefProposalOutcome | null;
  readonly threadRef: ScopedThreadRef;
}) {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(threadRef.environmentId, thread.projectId) : null,
  );
  const resolve = useAtomCommand(cadPanelEnvironment.resolveBriefProposal, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<"save" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changes = card.add.length + card.remove.length;

  const decide = async (decision: "save" | "dismiss") => {
    if (pending) return;
    setPending(decision);
    setError(null);
    try {
      const result = await resolve({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, proposalId: card.proposalId, decision },
      });
      if (result._tag === "Failure") {
        setError(decision === "save" ? "Could not save the brief." : "Could not dismiss this.");
        return;
      }
      // Same handoff the editor uses after a save, so an open editor shows the saved brief.
      const { contents, path } = result.value;
      if (contents !== null && project) {
        setProjectFileQueryData(threadRef.environmentId, project.workspaceRoot, path, contents);
        confirmProjectFileQueryData(threadRef.environmentId, project.workspaceRoot, path, contents);
      }
    } finally {
      setPending(null);
    }
  };
  const openBrief = () =>
    useRightPanelStore.getState().openFile(threadRef, card.path, undefined, { hideExplorer: true });

  if (outcome === "dismissed") return null;
  if (outcome === "saved")
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-muted-foreground text-xs"
        data-testid="design-brief-proposal-saved"
      >
        <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden />
        <span className="min-w-0 flex-1">
          Saved {changes === 1 ? "1 change" : `${changes} changes`} to {card.path}. Reviews use them
          from your next message.
        </span>
        <Button variant="ghost" size="xs" onClick={openBrief}>
          Open
        </Button>
      </div>
    );

  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card text-sm"
      data-testid="design-brief-proposal"
    >
      <div className="flex items-center gap-2 border-border border-b px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 text-foreground">Save to the design brief?</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{card.path}</span>
      </div>
      <ul className="py-1.5">
        {card.add.map((line, index) => (
          <ProposalLine key={`add-${index}`} sign="+" text={line.text}>
            You said <q className="text-foreground italic">{line.quote}</q>
          </ProposalLine>
        ))}
        {card.remove.map((line, index) => (
          <ProposalLine key={`remove-${index}`} sign="-" text={line.text}>
            {line.reason}
          </ProposalLine>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-border border-t px-3 py-2">
        <Button size="sm" disabled={pending !== null} onClick={() => void decide("save")}>
          Save to brief
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null}
          onClick={() => void decide("dismiss")}
        >
          Not now
        </Button>
        {error ? <span className="text-destructive text-xs">{error}</span> : null}
      </div>
    </div>
  );
}

function ProposalLine({
  sign,
  text,
  children,
}: {
  readonly sign: "+" | "-";
  readonly text: string;
  readonly children: React.ReactNode;
}) {
  const added = sign === "+";
  return (
    <li
      className={cn(
        "grid grid-cols-[1.25rem_1fr] gap-x-1 px-3 py-1",
        added ? "bg-success/10" : "bg-destructive/10",
      )}
    >
      <span
        className={cn("font-mono font-semibold", added ? "text-success" : "text-destructive")}
        aria-label={added ? "Add" : "Remove"}
      >
        {added ? "+" : "−"}
      </span>
      <span className={added ? "text-foreground" : "text-muted-foreground line-through"}>
        {text}
      </span>
      <span className="col-start-2 text-muted-foreground text-xs">{children}</span>
    </li>
  );
}
