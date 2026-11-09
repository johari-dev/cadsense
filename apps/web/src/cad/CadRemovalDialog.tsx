import type { CadStorageEntry } from "@cadsense/contracts";
import { create } from "zustand";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  DialogLocation,
  DialogRow,
  DialogRowStatus,
  DialogRows,
} from "../components/ui/dialog-rows";
import { Switch } from "../components/ui/switch";
type Choices = { deleteCad: boolean; deleteWorkspace: boolean };
type Request = {
  id: string;
  title: string;
  workspaceRoot: string;
  // A local CAD project's folder belongs to the user, so it never offers to delete the folder.
  source: CadStorageEntry["source"];
  /** Threads the removal keeps, shown as a count. Omitted for cleanup, which keeps none. */
  threadCount?: number;
  /** Deleting data of a project that is already removed, from Settings → Archive. */
  cleanup?: boolean;
  resolve: (choices: Choices | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let nextRequestId = 0;
export function requestCadRemoval(input: Omit<Request, "resolve" | "id">): Promise<Choices | null> {
  if (useRequest.getState().request) return Promise.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { ...input, id: String(++nextRequestId), resolve } }),
  );
}
const kept = <DialogRowStatus tone="neutral">Kept</DialogRowStatus>;
/**
 * Lists what removing a CAD project keeps (threads, captured images, the user's own files) and
 * lets the user choose which CAD data to delete. Deleted data does not come back on a restore.
 */
function RemovalChoices({ request }: { request: Request }) {
  const [deleteCad, setDeleteCad] = useState(true);
  const [deleteWorkspace, setDeleteWorkspace] = useState(false);
  const local = request.source === "local";
  const finish = (choices: Choices | null) => {
    useRequest.setState({ request: null });
    request.resolve(choices);
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request.cleanup ? `Delete data for ${request.title}` : `Remove ${request.title}`}
          </AlertDialogTitle>
          <DialogLocation>{request.workspaceRoot}</DialogLocation>
        </AlertDialogHeader>
        <div className="px-5 pb-4">
          <DialogRows>
            {!request.cleanup && (
              <>
                <DialogRow
                  label={
                    request.threadCount === undefined
                      ? "Threads"
                      : request.threadCount === 1
                        ? "1 thread"
                        : `${request.threadCount} threads`
                  }
                >
                  {kept}
                </DialogRow>
                <DialogRow label="Captured images">{kept}</DialogRow>
                {local && <DialogRow label="Files in the folder">{kept}</DialogRow>}
              </>
            )}
            <DialogRow
              asLabel
              label={local ? "Imported CAD data" : "Downloaded CAD data"}
              detail={
                local
                  ? "A restored project can import the file again"
                  : "Restoring doesn't bring it back"
              }
            >
              <Switch checked={deleteCad} onCheckedChange={setDeleteCad} />
            </DialogRow>
            {!local && (
              <DialogRow asLabel label="Workspace files" detail="Restoring doesn't bring them back">
                <Switch checked={deleteWorkspace} onCheckedChange={setDeleteWorkspace} />
              </DialogRow>
            )}
          </DialogRows>
        </div>
        <AlertDialogFooter className="sm:items-center">
          {!request.cleanup && (
            <p className="text-xs text-tertiary-foreground max-sm:text-center sm:me-auto">
              Restore it from Settings → Archive
            </p>
          )}
          <Button variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={request.cleanup && !deleteCad && !deleteWorkspace}
            onClick={() => finish({ deleteCad, deleteWorkspace })}
          >
            {request.cleanup ? "Delete data" : "Remove project"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
export function CadRemovalDialog() {
  const request = useRequest((state) => state.request);
  return request ? <RemovalChoices key={request.id} request={request} /> : null;
}
