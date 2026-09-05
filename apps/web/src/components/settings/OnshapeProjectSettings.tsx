import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import { type OnshapeProjectSource, isOnshapeProjectError } from "@cadsense/contracts";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { onshapeProjectUrl } from "../../lib/onshapeProjects";
import { onshapeProjectEnvironment } from "../../state/onshapeProjects";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useOnshapeConnectionsController } from "./useOnshapeConnectionsController";

export function OnshapeProjectSettings({
  project,
  source,
}: {
  project: Project;
  source: OnshapeProjectSource;
}) {
  const catalog = useOnshapeConnectionsController(project.environmentId);
  const setConnection = useAtomCommand(onshapeProjectEnvironment.setConnection, {
    reportFailure: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const compatible = catalog.connections.filter((connection) => connection.host === source.host);
  const current = compatible.find((connection) => connection.connectionId === source.connectionId);
  const selected = compatible.find(
    (connection) => connection.connectionId === (selectedId ?? source.connectionId),
  );
  const unavailable = !catalog.hasListData || catalog.listError !== null;

  const save = async () => {
    if (!selected || unavailable || pendingRef.current || catalog.pendingKey !== null) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await setConnection({
        environmentId: project.environmentId,
        input: { projectId: project.id, connectionId: selected.connectionId },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(
            isOnshapeProjectError(cause)
              ? cause.message
              : "Could not change the connection. Try again.",
          );
        }
        return;
      }
      setSelectedId(null);
      catalog.refresh();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <SettingsSection title="Onshape project">
      <SettingsRow
        title="CAD source"
        description="This project's source is fixed. Add another Onshape project to use a different source."
        control={
          <span className="max-w-full break-all text-xs text-muted-foreground sm:max-w-96">
            {onshapeProjectUrl(source)}
          </span>
        }
      />
      <SettingsRow
        title="Connection"
        description="Only connections for this Onshape host are shown. Changing the connection does not contact Onshape."
        control={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-80">
            <Select
              value={selected?.connectionId ?? null}
              onValueChange={(value) => {
                setSelectedId(value);
                setError(null);
              }}
              disabled={
                pending || unavailable || catalog.pendingKey !== null || compatible.length === 0
              }
            >
              <SelectTrigger aria-label="Onshape project connection" className="min-w-0 flex-1">
                <SelectValue
                  placeholder={
                    catalog.isListPending ? "Loading connections…" : "Choose a connection"
                  }
                >
                  {selected?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {compatible.map((connection) => (
                  <SelectItem key={connection.connectionId} value={connection.connectionId}>
                    {connection.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              disabled={
                !selected ||
                selected.connectionId === source.connectionId ||
                unavailable ||
                pending ||
                catalog.pendingKey !== null
              }
              onClick={() => void save()}
            >
              {pending ? "Saving…" : "Save connection"}
            </Button>
          </div>
        }
      />
      <div className="space-y-2 px-4 pb-4 text-sm">
        {unavailable ? (
          <p role="status" className="text-muted-foreground">
            {catalog.listError
              ? "Connections could not be loaded. Refresh to try again."
              : "Loading saved connections…"}
          </p>
        ) : !current ? (
          <p role="status" className="text-muted-foreground">
            This project's saved connection is unavailable for its Onshape host. Existing CAD stays
            available offline. Choose a compatible connection before a future sync.
          </p>
        ) : null}
        {source.managedWorkspaceReady === false ? (
          <p role="status" className="text-muted-foreground">
            The project workspace is still being prepared.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || catalog.isListPending}
            onClick={() => catalog.refresh()}
          >
            Refresh connections
          </Button>
          <Link to="/settings/integrations" className="text-sm underline underline-offset-4">
            Manage connections
          </Link>
        </div>
      </div>
    </SettingsSection>
  );
}
