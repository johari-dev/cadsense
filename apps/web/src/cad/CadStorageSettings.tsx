import { useAtomValue } from "@effect/atom-react";
import {
  type CadStorageEntry,
  type CadStorageInput,
  type EnvironmentId,
} from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { DatabaseIcon } from "lucide-react";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
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
          "The operation could not finish. Existing project records are preserved. Retry pending cleanup, or check that this project has not already been restored.",
        );
    } finally {
      setPending(false);
    }
  };
  const removeData = async (entry: CadStorageEntry) => {
    const choices = await requestCadRemoval({
      title: entry.title,
      workspaceRoot: entry.workspaceRoot,
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
          No removed Onshape projects. Removing a project can retain its downloaded CAD and
          workspace files here.
        </p>
      )}
      {state.value.map((entry) => (
        <article key={entry.projectId} className="space-y-3 rounded-lg border p-4">
          <div>
            <h3 className="text-sm font-medium">{entry.title}</h3>
            <p className="text-xs text-muted-foreground">
              {entry.cleanupPending ? "Cleanup pending" : "Retained project"} ·{" "}
              {entry.deleteCad && !entry.cleanupPending
                ? "Downloaded CAD deleted"
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
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((item) => item.environmentId === (selected ?? primary)) ?? environments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection title="CAD storage" icon={<DatabaseIcon className="size-4" />}>
        <div className="space-y-5 p-4">
          <p className="text-sm text-muted-foreground">
            Restore removed Onshape projects or delete retained files. These actions use local data
            and do not contact Onshape. Threads and captured images are preserved.
          </p>
          <label className="flex items-center gap-3 text-sm">
            Environment
            <select
              aria-label="CAD storage environment"
              className="rounded-md border bg-background p-2"
              value={environment?.environmentId ?? ""}
              onChange={(event) =>
                setSelected(
                  environments.find((item) => item.environmentId === event.target.value)
                    ?.environmentId ?? null,
                )
              }
            >
              {environments.map((item) => (
                <option key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {environment ? (
            <RetainedProjects
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
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
