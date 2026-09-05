import {
  MAX_ONSHAPE_PROJECT_URL_LENGTH,
  type EnvironmentId,
  type OnshapeConnectionId,
} from "@cadsense/contracts";
import { useId, useRef, useState } from "react";

import { useOnshapeConnectionsController } from "./settings/useOnshapeConnectionsController";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function OnshapeProjectCreateForm(props: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  connected: boolean;
  onCancel: () => void;
  onConfigure: () => void;
  onCreate: (input: {
    title: string;
    url: string;
    connectionId: OnshapeConnectionId;
  }) => Promise<string | null>;
}) {
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [connectionId, setConnectionId] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = useOnshapeConnectionsController(props.environmentId);
  const connections = catalog.connections;
  const connection = connections.find((item) => item.connectionId === connectionId);

  return (
    <form
      className="space-y-4 overflow-y-auto p-5"
      aria-label="Create Onshape project"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (submittingRef.current) return;
        if (!title.trim()) {
          setError("Enter a project name.");
          titleRef.current?.focus();
          return;
        }
        if (!url.trim()) {
          setError("Enter an Onshape document or element URL.");
          urlRef.current?.focus();
          return;
        }
        if (
          !connection ||
          !props.connected ||
          catalog.listError ||
          catalog.isListPending ||
          catalog.interactionsDisabled
        )
          return;
        submittingRef.current = true;
        setPending(true);
        setError(null);
        try {
          setError(
            await props.onCreate({
              title: title.trim(),
              url: url.trim(),
              connectionId: connection.connectionId,
            }),
          );
        } catch {
          setError("Could not create the Onshape project. Try again.");
        } finally {
          submittingRef.current = false;
          setPending(false);
        }
      }}
    >
      <div>
        <h2 className="text-base font-medium">New Onshape project</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          On {props.environmentLabel}. Creating a project uses no Onshape API requests.
        </p>
      </div>
      {!props.connected && (
        <p role="alert" className="text-sm text-destructive">
          This environment is disconnected.
        </p>
      )}
      {catalog.listError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>Could not load saved connections.</p>
          <Button
            type="button"
            variant="outline"
            onClick={catalog.refresh}
            disabled={catalog.isListPending}
          >
            Retry
          </Button>
        </div>
      ) : !catalog.hasListData ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading connections…
        </p>
      ) : connections.length === 0 ? (
        <div className="space-y-2 text-sm">
          <p>Add an Onshape connection to create a project.</p>
          <Button type="button" variant="outline" onClick={props.onConfigure}>
            Open integration settings
          </Button>
        </div>
      ) : (
        <fieldset
          disabled={pending || !props.connected || catalog.interactionsDisabled}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`${id}-connection`}>
              Connection
            </label>
            <select
              id={`${id}-connection`}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-ring"
              value={connection?.connectionId ?? ""}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              <option value="" disabled>
                Select a connection
              </option>
              {connections.map((item) => (
                <option key={item.connectionId} value={item.connectionId}>
                  {item.name} · {item.host}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`${id}-name`}>
              Project name
            </label>
            <Input
              autoFocus
              ref={titleRef}
              id={`${id}-name`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="My CAD"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`${id}-url`}>
              Onshape URL
            </label>
            <Input
              ref={urlRef}
              id={`${id}-url`}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://cad.onshape.com/documents/…"
              maxLength={MAX_ONSHAPE_PROJECT_URL_LENGTH}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Paste a document or element link. CAD snapshots are synced manually.
            </p>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={props.onCancel}>
          Back
        </Button>
        <Button
          type="submit"
          disabled={
            pending ||
            !connection ||
            !props.connected ||
            catalog.isListPending ||
            catalog.interactionsDisabled ||
            catalog.listError !== null
          }
        >
          {pending ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}
