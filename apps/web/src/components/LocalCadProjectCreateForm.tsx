import { squashAtomCommandFailure } from "@cadsense/client-runtime/state/runtime";
import type { EnvironmentId, LocalCadFilesListResult } from "@cadsense/contracts";
import { useId, useRef, useState } from "react";

import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { localCadProjectEnvironment } from "../state/localCadProjects";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Radio, RadioGroup } from "./ui/radio-group";

const fileSize = (bytes: number) =>
  bytes < 1024 ** 2
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/**
 * Picks a folder, lists its STEP and IGES files, and creates a project that reviews the chosen one.
 * `pickFolder` is null without a native folder picker (a browser, or a remote environment); the
 * form then takes a typed path, which the server resolves.
 */
export function LocalCadProjectCreateForm(props: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  connected: boolean;
  pickFolder: (() => Promise<string | null>) | null;
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    workspaceRoot: string;
    filePath: string;
  }) => Promise<string | null>;
}) {
  const id = useId();
  const listFiles = useAtomCommand(localCadProjectEnvironment.listFiles, { reportFailure: false });
  const submittingRef = useRef(false);
  const [listing, setListing] = useState<LocalCadFilesListResult | null>(null);
  const [typedFolder, setTypedFolder] = useState("");
  const [scanning, setScanning] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending || scanning;

  const scan = async (workspaceRoot: string) => {
    setScanning(true);
    setError(null);
    try {
      const result = await listFiles({
        environmentId: props.environmentId,
        input: { workspaceRoot },
      });
      if (result._tag === "Failure") {
        setError(errorMessage(squashAtomCommandFailure(result), "Could not read that folder."));
        return;
      }
      setListing(result.value);
      // One file is the obvious choice. With several, the user picks.
      setFilePath((current) =>
        result.value.files.some((file) => file.path === current)
          ? current
          : result.value.files.length === 1
            ? result.value.files[0]!.path
            : null,
      );
      if (!titleEdited) setTitle(inferProjectTitleFromPath(result.value.workspaceRoot));
    } finally {
      setScanning(false);
    }
  };

  const chooseFolder = async () => {
    if (!props.pickFolder || busy) return;
    const folder = await props.pickFolder();
    if (folder) await scan(folder);
  };

  return (
    <form
      className="space-y-4 overflow-y-auto p-5"
      aria-label="Create local CAD project"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (submittingRef.current || !listing) return;
        if (!filePath) {
          setError("Choose the CAD file to review.");
          return;
        }
        if (!title.trim()) {
          setError("Enter a project name.");
          return;
        }
        submittingRef.current = true;
        setPending(true);
        setError(null);
        try {
          setError(
            await props.onCreate({
              title: title.trim(),
              workspaceRoot: listing.workspaceRoot,
              filePath,
            }),
          );
        } catch {
          setError("Could not create the local CAD project. Try again.");
        } finally {
          submittingRef.current = false;
          setPending(false);
        }
      }}
    >
      <div>
        <h2 className="text-base font-medium">New local CAD project</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          On {props.environmentLabel}. Review a STEP or IGES file in a folder. Nothing is uploaded,
          and you can sync again after re-exporting.
        </p>
      </div>
      {!props.connected && (
        <p role="alert" className="text-sm text-destructive">
          This environment is disconnected.
        </p>
      )}
      <fieldset disabled={pending || !props.connected} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={`${id}-folder`}>
            Folder
          </label>
          {props.pickFolder ? (
            <div className="flex items-center gap-2">
              <p
                id={`${id}-folder`}
                className="min-w-0 flex-1 break-all rounded-lg border border-input px-3 py-2 text-sm text-muted-foreground"
              >
                {listing?.workspaceRoot ?? "No folder chosen"}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                {listing ? "Change…" : "Choose folder…"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                id={`${id}-folder`}
                autoFocus
                value={typedFolder}
                onChange={(event) => setTypedFolder(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (typedFolder.trim() && !busy) void scan(typedFolder.trim());
                }}
                placeholder="~/cad/my-robot"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || !typedFolder.trim()}
                onClick={() => void scan(typedFolder.trim())}
              >
                Scan
              </Button>
            </div>
          )}
        </div>
        {listing && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium" id={`${id}-files`}>
                CAD file
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void scan(listing.workspaceRoot)}
              >
                {scanning ? "Scanning…" : "Rescan"}
              </Button>
            </div>
            {listing.files.length === 0 ? (
              <p role="status" className="rounded-lg border p-3 text-sm text-muted-foreground">
                No STEP or IGES files in this folder. Export one from your CAD tool, then rescan.
              </p>
            ) : (
              <RadioGroup
                aria-labelledby={`${id}-files`}
                value={filePath ?? ""}
                onValueChange={(value) => setFilePath(typeof value === "string" ? value : null)}
                className="max-h-64 gap-0 overflow-y-auto rounded-lg border"
              >
                {listing.files.map((file) => (
                  <label
                    key={file.path}
                    className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 has-data-checked:bg-accent/60"
                  >
                    <Radio value={file.path} />
                    <span className="min-w-0 flex-1 break-all text-sm">{file.path}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {fileSize(file.byteLength)}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
            {listing.truncated && (
              <p className="text-xs text-muted-foreground">
                This folder is large, so only part of it was scanned. Choose a smaller folder if the
                file is missing.
              </p>
            )}
          </div>
        )}
        {listing && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={`${id}-name`}>
              Project name
            </label>
            <Input
              id={`${id}-name`}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleEdited(true);
              }}
              autoComplete="off"
            />
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={props.onCancel}>
          Back
        </Button>
        <Button type="submit" disabled={busy || !props.connected || !listing || !filePath}>
          {pending ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}
