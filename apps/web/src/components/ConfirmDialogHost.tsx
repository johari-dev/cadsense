import { useEffect, useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  DialogLocation,
  DialogRow,
  DialogRowStatus,
  DialogRows,
  DialogWarning,
} from "./ui/dialog-rows";

/** Mounted once in the root layout. Shows each `requestConfirmDialog` request in turn. */
export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  // The request stays rendered while the dialog animates closed.
  const request = state.status === "idle" ? null : state.request;
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);
  const hasBody = request?.rows?.length || request?.warning;

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      {request ? (
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{request.title}</AlertDialogTitle>
            {request.location ? <DialogLocation>{request.location}</DialogLocation> : null}
            {request.description ? (
              <AlertDialogDescription>{request.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          {hasBody ? (
            <div className="grid gap-3 px-5 pb-4">
              {request.rows?.length ? (
                <DialogRows>
                  {request.rows.map((row) => (
                    <DialogRow key={row.label} label={row.label} detail={row.detail}>
                      {row.status ? (
                        <DialogRowStatus tone={row.status.tone}>{row.status.label}</DialogRowStatus>
                      ) : null}
                    </DialogRow>
                  ))}
                </DialogRows>
              ) : null}
              {request.warning ? <DialogWarning>{request.warning}</DialogWarning> : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {request.cancelLabel ?? "Cancel"}
            </AlertDialogClose>
            <Button variant={request.variant ?? "default"} onClick={onConfirm}>
              {request.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      ) : null}
    </AlertDialog>
  );
}
