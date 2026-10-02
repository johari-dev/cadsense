import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { newCommandId } from "../../lib/utils";
import { cadPanelEnvironment } from "../../state/cadPanel";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Lists the reasons users gave when dismissing findings in this project, each removable. */
export function CadReviewLearnings({ project }: { project: Project }) {
  const state = useAtomValue(
    cadPanelEnvironment.learnings({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const remove = useAtomCommand(cadPanelEnvironment.removeLearning, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const learnings = AsyncResult.isSuccess(state) ? state.value : [];
  const removeLearning = async (learningId: string) => {
    if (pending) return;
    setPending(learningId);
    setError(null);
    try {
      const result = await remove({
        environmentId: project.environmentId,
        input: { projectId: project.id, learningId, commandId: newCommandId() },
      });
      if (result._tag === "Failure") setError("Could not remove this learning.");
    } finally {
      setPending(null);
    }
  };
  return (
    <SettingsSection title="Review learnings">
      <SettingsRow
        title="Dismissal reasons"
        description="Reasons given when dismissing findings. Agents apply them to later reviews of this project and do not repeat dismissed findings."
      >
        {learnings.length > 0 ? (
          <ul className="divide-y text-sm">
            {learnings.map((learning) => (
              <li key={learning.id} className="flex items-start justify-between gap-3 py-1.5">
                <span className="min-w-0 break-words">{learning.text}</span>
                <Button
                  size="icon-micro"
                  variant="ghost"
                  aria-label="Remove learning"
                  disabled={pending !== null}
                  onClick={() => void removeLearning(learning.id)}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pb-2 text-sm text-muted-foreground">
            {AsyncResult.isFailure(state)
              ? "Learnings are unavailable."
              : "None yet. Dismiss a finding with a reason to add one."}
          </p>
        )}
        {error ? (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
