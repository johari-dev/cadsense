import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cadsense/client-runtime/state/runtime";
import { CadUserOperationError, type CadUserStartInput } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { onshapeProjectEnvironment } from "../../state/onshapeProjects";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const size = (bytes: number) =>
  bytes < 1024 ** 2 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const timestamp = (value: string) => new Date(value).toLocaleString();
const isCadUserOperationError = Schema.is(CadUserOperationError);

export function CadProjectSettings({
  project,
  runActive,
}: {
  project: Project;
  runActive: boolean;
}) {
  const start = useAtomCommand(onshapeProjectEnvironment.startCadOperation, {
    reportFailure: false,
  });
  const cancel = useAtomCommand(onshapeProjectEnvironment.cancelCadOperation, {
    reportFailure: false,
  });
  const setEnabled = useAtomCommand(onshapeProjectEnvironment.setCadEnabled, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [elementId, setElementId] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState(
    project.onshapeSource?.configuration || "default",
  );
  const cad = project.cad;
  const retryAt = cad?.lastOutcome?.retryAt;
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, Date.parse(retryAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [retryAt]);
  const throttled = !!retryAt && Date.parse(retryAt) > clock;
  const enabled = cad?.enabled !== false;
  const operation = cad?.operation;
  const locked =
    runActive || pending || !!operation || project.onshapeSource?.managedWorkspaceReady === false;
  const selected = cad?.catalog?.roots.find((root) => root.elementId === elementId);
  const remoteLocked = locked || !enabled || throttled;
  const perform = async (action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(
          isCadUserOperationError(cause) && cause.reason === "busy"
            ? "CAD is busy. Wait for agent runs and the current operation to finish."
            : "The CAD action could not be completed. Existing downloaded CAD is unchanged.",
        );
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const sync = (root: Extract<CadUserStartInput, { kind: "sync" }>["root"]) => {
    if (remoteLocked) return;
    void perform(() =>
      start({
        environmentId: project.environmentId,
        input: { projectId: project.id, kind: "sync", root },
      }),
    );
  };
  return (
    <SettingsSection title="CAD">
      <SettingsRow
        title="Downloaded CAD"
        description="Snapshots are local and read-only. Only you can refresh the CAD catalog or sync a snapshot. Each action uses Onshape API requests."
        control={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => {
                if (locked) return;
                void perform(() =>
                  setEnabled({
                    environmentId: project.environmentId,
                    input: { projectId: project.id, enabled: !enabled },
                  }),
                );
              }}
            >
              {enabled ? "Turn off CAD" : "Turn on CAD"}
            </Button>
            <Button
              size="sm"
              disabled={remoteLocked}
              onClick={() => {
                if (remoteLocked) return;
                void perform(() =>
                  start({
                    environmentId: project.environmentId,
                    input: { projectId: project.id, kind: "discover" },
                  }),
                );
              }}
            >
              Refresh CAD catalog
            </Button>
          </div>
        }
      />
      <div className="space-y-4 px-4 pb-4">
        {throttled && retryAt ? (
          <p role="status" className="text-sm text-muted-foreground">
            Onshape requests can be tried again after {timestamp(retryAt)}. No automatic retry is
            scheduled.
          </p>
        ) : null}
        {runActive ? (
          <p role="status" className="text-sm text-muted-foreground">
            CAD controls are locked while an agent run is active in this project.
          </p>
        ) : null}
        {!enabled ? (
          <p className="text-sm text-muted-foreground">
            CAD access is off. Your source, downloaded data, and saved views are kept.
          </p>
        ) : null}
        {operation ? (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
          >
            <span>
              {operation.kind === "discover" ? "Refreshing CAD catalog…" : "Syncing CAD snapshot…"}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void perform(() =>
                  cancel({
                    environmentId: project.environmentId,
                    input: { projectId: project.id, operationId: operation.operationId },
                  }),
                )
              }
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {cad?.catalog ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Catalog refreshed {timestamp(cad.catalog.refreshedAt)}
            </p>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
              <div className="space-y-1.5">
                <span className="text-sm font-medium">CAD root</span>
                <Select
                  value={elementId}
                  onValueChange={setElementId}
                  disabled={locked || !enabled}
                >
                  <SelectTrigger aria-label="CAD root">
                    <SelectValue placeholder="Choose CAD">{selected?.name}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {cad.catalog.roots.map((root) => (
                      <SelectItem key={root.elementId} value={root.elementId}>
                        {root.name} · {root.kind === "assembly" ? "Assembly" : "Part Studio"}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <label className="space-y-1.5 text-sm font-medium">
                Configuration
                <Input
                  value={configuration}
                  maxLength={4096}
                  disabled={locked || !enabled}
                  onChange={(event) => setConfiguration(event.target.value)}
                  placeholder="default"
                />
              </label>
              <Button
                disabled={remoteLocked || !selected}
                onClick={() => {
                  if (selected)
                    sync({
                      elementId: selected.elementId,
                      kind: selected.kind,
                      configuration: configuration || "default",
                    });
                }}
              >
                Sync snapshot
              </Button>
            </div>
            {cad.catalog.roots.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Assembly or Part Studio roots were found in this CAD document.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Refresh the CAD catalog to choose an Assembly or Part Studio. Nothing is downloaded
            automatically.
          </p>
        )}
        {cad?.roots.map((root) => (
          <div
            key={root.rootId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="break-words text-sm font-medium">
                {cad.catalog?.roots.find((entry) => entry.elementId === root.elementId)?.name ??
                  (root.kind === "assembly" ? "Assembly" : "Part Studio")}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Configuration: {root.configuration}
              </p>
              <p className="text-xs text-muted-foreground">
                {root.current
                  ? `Synced ${timestamp(root.current.createdAt)} · ${size(root.current.assetBytes + root.current.manifestBytes)}`
                  : "No snapshot downloaded"}
              </p>
              {root.rollback ? (
                <p className="text-xs text-muted-foreground">
                  One previous snapshot retained for recovery.
                </p>
              ) : null}
              {root.lastOutcome?.reason ? (
                <p className="max-w-xl text-xs text-muted-foreground">{root.lastOutcome.reason}</p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={remoteLocked}
              onClick={() =>
                sync({
                  elementId: root.elementId,
                  kind: root.kind,
                  configuration: root.configuration,
                })
              }
            >
              Sync
            </Button>
          </div>
        ))}
        {!operation && cad?.lastOutcome ? (
          <p role="status" className="text-sm text-muted-foreground">
            {cad.lastOutcome.reason ??
              (cad.lastOutcome.kind === "discover"
                ? "CAD catalog refreshed."
                : "CAD snapshot synced.")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
