import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import {
  type OnshapeProjectSource,
  type OnshapeVersionCheckResult,
  isOnshapeProjectError,
} from "@cadsense/contracts";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { onshapeProjectUrl } from "../../lib/onshapeProjects";
import { onshapeProjectEnvironment } from "../../state/onshapeProjects";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useOnshapeConnectionsController } from "./useOnshapeConnectionsController";

const retryTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Short text shown next to "Check now" for a manual version check. */
export function versionCheckText(result: OnshapeVersionCheckResult): string {
  switch (result.status) {
    case "no-new-versions":
      return "No new versions";
    case "reviewing":
      return `Reviewing ${result.versions.map((version) => `v${version.ordinal}`).join(", ")}`;
    case "skipped":
      return result.reason === "in-progress"
        ? "Check already running"
        : result.reason === "disabled"
          ? "Version reviews are off"
          : "Checked recently";
    case "backing-off":
      return `Onshape paused, retry after ${retryTime(result.retryAt)}`;
    case "failed":
      return `Check failed, retry after ${retryTime(result.retryAt)}`;
  }
}

export function OnshapeProjectSettings({
  project,
  source,
  busy = false,
}: {
  project: Project;
  source: OnshapeProjectSource;
  busy?: boolean;
}) {
  const catalog = useOnshapeConnectionsController(project.environmentId);
  const setConnection = useAtomCommand(onshapeProjectEnvironment.setConnection, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const checkVersions = useAtomCommand(onshapeProjectEnvironment.checkVersions, {
    reportFailure: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const autoReviewVersions = source.autoReviewVersions === true;
  const [checkPending, setCheckPending] = useState(false);
  const [checkText, setCheckText] = useState<string | null>(null);
  const checkNow = async () => {
    if (checkPending) return;
    setCheckPending(true);
    setCheckText(null);
    try {
      const result = await checkVersions({
        environmentId: project.environmentId,
        input: { projectId: project.id, reason: "manual" },
      });
      if (result._tag === "Success") setCheckText(versionCheckText(result.value));
      else if (!isAtomCommandInterrupted(result)) setCheckText("Could not check. Try again.");
    } finally {
      setCheckPending(false);
    }
  };
  const setAutoReviewVersions = async (enabled: boolean) => {
    if (reviewPending) return;
    setReviewPending(true);
    setError(null);
    try {
      const result = await updateProject({
        environmentId: project.environmentId,
        input: { projectId: project.id, onshapeAutoReviewVersions: enabled },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError("Could not change version reviews. Try again.");
      }
    } finally {
      setReviewPending(false);
    }
  };
  const compatible = catalog.connections.filter((connection) => connection.host === source.host);
  const current = compatible.find((connection) => connection.connectionId === source.connectionId);
  const selected = compatible.find(
    (connection) => connection.connectionId === (selectedId ?? source.connectionId),
  );
  const unavailable = !catalog.hasListData || catalog.listError !== null;

  const save = async () => {
    if (busy || !selected || unavailable || pendingRef.current || catalog.pendingKey !== null)
      return;
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
                busy ||
                pending ||
                unavailable ||
                catalog.pendingKey !== null ||
                compatible.length === 0
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
                busy ||
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
      <SettingsRow
        title="Review new Onshape versions"
        description="Opening this project checks the document for new named versions, at most once every 15 minutes. Each check is one Onshape API request. Each new version syncs the CAD snapshot and starts a review thread. Versions that exist when this is turned on are not reviewed."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {autoReviewVersions ? (
              <>
                {checkText ? (
                  <span role="status" className="text-xs text-muted-foreground">
                    {checkText}
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={checkPending || reviewPending}
                  onClick={() => void checkNow()}
                >
                  Check now
                </Button>
              </>
            ) : null}
            <Switch
              aria-label="Review new Onshape versions"
              checked={autoReviewVersions}
              disabled={reviewPending}
              onCheckedChange={(checked) => void setAutoReviewVersions(checked)}
            />
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
          <Link
            to="/settings/integrations"
            search={{ environmentId: project.environmentId }}
            className="text-sm underline underline-offset-4"
          >
            Manage connections
          </Link>
        </div>
      </div>
    </SettingsSection>
  );
}
