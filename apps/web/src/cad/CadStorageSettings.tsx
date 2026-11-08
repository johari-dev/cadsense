import { useAtomValue } from "@effect/atom-react";
import {
  type CadStorageEntry,
  type CadStorageInput,
  type EnvironmentId,
} from "@cadsense/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { usePrimaryEnvironmentId } from "../state/environments";
import { cadStorageEnvironment } from "../state/cadStorage";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
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
          ? "Removed projects are unavailable in this environment."
          : "Loading removed projects…"}
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
          No removed projects. Removing a CAD project can keep its threads and CAD data here.
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
/**
 * Removed CAD projects, shown at the bottom of the Archive tab. Each entry can be restored or
 * have its retained data deleted. Links reach it with the `cad-storage` hash.
 */
export function CadStorageSection() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsSection {...searchableSetting("cad-storage")}>
      <div className="space-y-4 px-3 pt-1 pb-4 sm:px-4">
        <p className="text-[13px] leading-[1.45] text-muted-foreground">
          Restore a removed project or delete the data kept for it. This never contacts Onshape or
          changes a local project's folder.
        </p>
        {environmentId ? (
          <RetainedProjects key={environmentId} environmentId={environmentId} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Connect an environment to see removed projects.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
