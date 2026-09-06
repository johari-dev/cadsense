import { create } from "zustand";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
type Choices = { deleteCad: boolean; deleteWorkspace: boolean };
type Request = {
  id: string;
  title: string;
  workspaceRoot: string;
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
function RemovalChoices({ request }: { request: Request }) {
  const [deleteCad, setDeleteCad] = useState(true);
  const [deleteWorkspace, setDeleteWorkspace] = useState(false);
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
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request.cleanup ? "Delete retained data" : "Remove Onshape project"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {request.title}. Threads and captured images are preserved. You can restore the project
            from Settings → CAD storage.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4 px-6 py-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={deleteCad} onCheckedChange={setDeleteCad} />
            Delete downloaded CAD data
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={deleteWorkspace} onCheckedChange={setDeleteWorkspace} />
            Delete workspace files
          </label>
          <p className="break-all rounded-md bg-muted p-3 font-mono text-xs">
            {request.workspaceRoot}
          </p>
          <p className="text-xs text-muted-foreground">
            Selected data will be permanently deleted. Restoring the project does not recover
            deleted files.
          </p>
        </div>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => finish({ deleteCad, deleteWorkspace })}>
            {request.cleanup ? "Delete selected data" : "Remove project"}
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
