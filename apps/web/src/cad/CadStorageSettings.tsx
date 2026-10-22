import { useAtomValue } from "@effect/atom-react";
import {
  type CadStorageEntry,
  type CadStorageInput,
  type EnvironmentId,
} from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { DatabaseIcon } from "~/lib/icons";
import { usePrimaryEnvironmentId } from "../state/environments";
import { cadStorageEnvironment } from "../state/cadStorage";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { requestCadRemoval } from "./CadRemovalDialog";

function RetainedProjects({ environmentId }: { environmentId: EnvironmentId }) {
  const state = useAtomValue(cadStorageEnvironment.watch({ environmentId, input: {} }));
  const run = useAtomCommand(cadStorageEnvironment.run, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execute = async (input: CadStorageInput) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await run({ environmentId, input });
      if (result._tag === "Failure")
        setError(
          "The operation could not finish. Existing project records are preserved. Retry pending cleanup, or check that this project has not already been restored and that no other project uses its folder or Onshape document.",
        );
    } finally {
      setPending(false);
    }
  };
  const removeData = async (entry: CadStorageEntry) => {
    const choices = await requestCadRemoval({
      title: entry.title,
      workspaceRoot: entry.workspaceRoot,
      source: entry.source,
      cleanup: true,
    });
    if (choices && (choices.deleteCad || choices.deleteWorkspace))
      await execute({
        kind: "cleanup",
        projectId: entry.projectId,
        removedAt: entry.removedAt,
        ...choices,
      });
  };
  if (!AsyncResult.isSuccess(state))
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {AsyncResult.isFailure(state)
          ? "CAD storage is unavailable in this environment."
          : "Loading CAD storage…"}
      </p>
    );
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {state.value.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No removed CAD projects. Removing an Onshape or local CAD project can keep its threads and
          CAD data here.
        </p>
      )}
      {state.value.map((entry) => (
        <article key={entry.projectId} className="space-y-3 rounded-lg border p-4">
          <div>
            <h3 className="text-sm font-medium">{entry.title}</h3>
            <p className="text-xs text-muted-foreground">
              {entry.cleanupPending ? "Cleanup pending" : "Retained project"} ·{" "}
              {entry.deleteCad && !entry.cleanupPending
                ? `${entry.source === "local" ? "Imported" : "Downloaded"} CAD deleted`
                : `Snapshot data: ${(entry.byteLength / 1024 ** 2).toFixed(1)} MiB (before shared-geometry savings)`}
            </p>
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{entry.workspaceRoot}</p>
          {entry.deleteWorkspace && !entry.cleanupPending && (
            <p className="text-xs text-muted-foreground">
              Workspace files were deleted. Restore creates an empty workspace.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending || entry.cleanupPending}
              onClick={() =>
                void execute({
                  kind: "restore",
                  projectId: entry.projectId,
                  removedAt: entry.removedAt,
                })
              }
            >
              Restore project
            </Button>
            {entry.cleanupPending ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void execute({
                    kind: "retry",
                    projectId: entry.projectId,
                    removedAt: entry.removedAt,
                  })
                }
              >
                Retry cleanup
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void removeData(entry)}
              >
                Delete retained data
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
export function CadStorageSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      <SettingsSection title="CAD storage" icon={<DatabaseIcon className="size-4" />}>
        <div className="space-y-5 p-4">
          <p className="text-sm text-muted-foreground">
            Restore removed Onshape and local CAD projects, or delete their retained data. These
            actions use local data, do not contact Onshape, and never change a local project's
            folder. Threads and captured images are preserved.
          </p>
          {environmentId ? (
            <RetainedProjects key={environmentId} environmentId={environmentId} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Connect an environment to inspect CAD storage.
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
