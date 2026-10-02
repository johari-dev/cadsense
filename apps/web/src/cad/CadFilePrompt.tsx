import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cadsense/client-runtime/state/runtime";
import { LOCAL_CAD_FILE_EXTENSIONS, type LocalCadFileEntry } from "@cadsense/contracts";
import { FileBoxIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { isElectron } from "../env";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { readLocalApi } from "../localApi";
import { useEnvironments } from "../state/environments";
import { localCadProjectEnvironment } from "../state/localCadProjects";
import { useAtomCommand } from "../state/use-atom-command";
import type { Project } from "../types";

// Both cases, since some Linux file dialogs match extensions case-sensitively.
const CAD_FILE_FILTERS = [
  {
    name: "STEP or IGES",
    extensions: LOCAL_CAD_FILE_EXTENSIONS.flatMap((extension) => [
      extension.slice(1),
      extension.slice(1).toUpperCase(),
    ]),
  },
];

const failureMessage = (result: AtomCommandResult<unknown, unknown>, fallback: string) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message ? cause.message : fallback;
};

/**
 * What the CAD panel shows in a folder project with nothing imported: the linked file's import
 * progress or failure, and a button that picks a STEP or IGES file in the project folder and
 * imports it. The desktop app opens the native file dialog; a browser, which cannot read a path
 * from one, lists the folder's CAD files instead.
 */
export function CadFilePrompt({ project }: { project: Project }) {
  const { environments } = useEnvironments();
  const environment = environments.find((item) => item.environmentId === project.environmentId);
  const backendId = environment ? desktopLocalBackendId(environment.entry.target) : null;
  // A native dialog browses the machine running the app, so it only fits local backends.
  const nativePicker =
    isElectron &&
    !!environment &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" || backendId !== null);
  const setFile = useAtomCommand(localCadProjectEnvironment.setFile, { reportFailure: false });
  const listFiles = useAtomCommand(localCadProjectEnvironment.listFiles, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<readonly LocalCadFileEntry[] | null>(null);
  const folder = inferProjectTitleFromPath(project.workspaceRoot);
  const cad = project.cad;
  const linked = project.localCadSource?.filePath;
  const busy = pending || !!cad?.operation;

  const link = async (filePath: string) => {
    setPending(true);
    setError(null);
    try {
      const result = await setFile({
        environmentId: project.environmentId,
        input: { projectId: project.id, filePath },
      });
      setError(failureMessage(result, "Could not link that file."));
    } finally {
      setPending(false);
    }
  };
  const pickNative = async () => {
    const api = readLocalApi();
    if (!api || busy) return;
    const filePath = await api.dialogs.pickFile({
      initialPath: project.workspaceRoot,
      ...(backendId ? { targetEnvironmentId: backendId } : {}),
      filters: CAD_FILE_FILTERS,
    });
    if (filePath) await link(filePath);
  };
  const scanFolder = async () => {
    setFiles(null);
    const result = await listFiles({
      environmentId: project.environmentId,
      input: { workspaceRoot: project.workspaceRoot },
    });
    setFiles(result._tag === "Success" ? result.value.files : []);
    setError(failureMessage(result, `Could not read ${folder}.`));
  };

  if (cad?.operation?.kind === "sync")
    return (
      <div role="status" className="flex flex-1 items-center justify-center p-8 text-sm">
        <span className="text-muted-foreground">Importing {linked ?? "CAD"}…</span>
      </div>
    );
  const failure =
    linked && cad?.lastOutcome && cad.lastOutcome.status !== "succeeded"
      ? cad.lastOutcome.reason
      : null;
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <FileBoxIcon aria-hidden className="size-8 text-muted-foreground/60" />
        <div className="space-y-1">
          <p className="break-all text-sm font-medium">{linked ?? "No CAD file linked"}</p>
          <p className="text-sm text-muted-foreground">
            {failure ??
              (linked
                ? "This file has not been imported yet."
                : `Pick a STEP or IGES file in ${folder} to review it here.`)}
          </p>
        </div>
        {nativePicker ? (
          <Button disabled={busy} onClick={() => void pickNative()}>
            {pending ? "Importing…" : "Pick a file"}
          </Button>
        ) : (
          <Menu
            onOpenChange={(open) => {
              if (open) void scanFolder();
            }}
          >
            <MenuTrigger render={<Button disabled={busy} />}>
              {pending ? "Importing…" : "Pick a file"}
            </MenuTrigger>
            <MenuPopup>
              {files === null ? (
                <MenuItem disabled>Scanning {folder}…</MenuItem>
              ) : files.length === 0 ? (
                <MenuItem disabled>No STEP or IGES files in {folder}</MenuItem>
              ) : (
                files.map((file) => (
                  <MenuItem key={file.path} onClick={() => void link(file.path)}>
                    {file.path}
                  </MenuItem>
                ))
              )}
            </MenuPopup>
          </Menu>
        )}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
