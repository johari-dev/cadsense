import { useEffect, useRef } from "react";

import type { OnshapeConnectionOperationSnapshot } from "./onshapeConnectionOperationStore";
import type { OnshapeConnectionEditor } from "./useOnshapeConnectionsController";

type OperationNotice = OnshapeConnectionOperationSnapshot["notice"];
type OperationCompletion = OnshapeConnectionOperationSnapshot["completion"];

function editorFocusKey(editor: Exclude<OnshapeConnectionEditor, null>): string {
  return editor.kind === "add" ? "add" : `${editor.kind}:${editor.connectionId}`;
}

/** Keeps keyboard focus anchored as transient connection UI appears and disappears. */
export function useOnshapeConnectionsFocus({
  connected,
  editor,
  operationNotice,
  operationCompletion,
  sectionId,
}: {
  readonly connected: boolean;
  readonly editor: OnshapeConnectionEditor;
  readonly operationNotice: OperationNotice;
  readonly operationCompletion: OperationCompletion;
  readonly sectionId: string;
}) {
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const discardEditButtonRef = useRef<HTMLButtonElement>(null);
  const unavailableStatusRef = useRef<HTMLDivElement>(null);
  const operationStatusRef = useRef<HTMLDivElement>(null);
  const connectionContentRef = useRef<HTMLDivElement>(null);
  const wasConnected = useRef(connected);
  const previousOperationNotice = useRef(operationNotice);
  const previousCompletionSequence = useRef(operationCompletion?.sequence ?? 0);
  const previousEditor = useRef(editor);
  const focusBelongedToSection = useRef(false);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const section = document.getElementById(sectionId);
    const updateFocusOwner = (event: FocusEvent) => {
      focusBelongedToSection.current =
        event.target instanceof Node && (section?.contains(event.target) ?? false);
    };
    const updateFocusOwnerOnExit = (event: FocusEvent) => {
      focusBelongedToSection.current =
        event.relatedTarget instanceof Node && (section?.contains(event.relatedTarget) ?? false);
    };
    const activeElement = document.activeElement;
    if (activeElement !== null && activeElement !== document.body) {
      focusBelongedToSection.current = section?.contains(activeElement) ?? false;
    }
    document.addEventListener("focusin", updateFocusOwner);
    document.addEventListener("focusout", updateFocusOwnerOnExit);
    return () => {
      document.removeEventListener("focusin", updateFocusOwner);
      document.removeEventListener("focusout", updateFocusOwnerOnExit);
    };
  }, [sectionId]);

  useEffect(() => {
    const focusConnectedTarget = (preferredKey?: string) => {
      if (operationNotice !== null) {
        operationStatusRef.current?.focus();
        return;
      }
      if (editor !== null) {
        connectionContentRef.current
          ?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")
          ?.focus();
        return;
      }
      const preferredTarget =
        preferredKey === undefined
          ? null
          : connectionContentRef.current?.querySelector<HTMLElement>(
              `[data-onshape-focus-key="${preferredKey}"]`,
            );
      if (preferredTarget !== null && preferredTarget !== undefined) {
        preferredTarget.focus();
      } else if (addButtonRef.current !== null) {
        addButtonRef.current.focus();
      } else {
        document.getElementById(sectionId)?.focus();
      }
    };
    const focusDisconnectedTarget = () => {
      if (operationNotice !== null) {
        operationStatusRef.current?.focus();
      } else if (editor !== null) {
        discardEditButtonRef.current?.focus();
      } else {
        unavailableStatusRef.current?.focus();
      }
    };

    const previousNotice = previousOperationNotice.current;
    const previousEditorValue = previousEditor.current;
    const noticeStarted = previousNotice?._tag !== "Pending" && operationNotice?._tag === "Pending";
    const noticeEnded = previousNotice !== null && operationNotice === null;
    const operationCompleted =
      operationCompletion !== null &&
      operationCompletion.sequence !== previousCompletionSequence.current;
    const editorClosed = previousEditorValue !== null && editor === null;

    // The environment may change in the background while the user is working
    // elsewhere in Settings. Only recover focus we already owned.
    if (focusBelongedToSection.current && noticeStarted) {
      operationStatusRef.current?.focus();
    } else if (focusBelongedToSection.current && wasConnected.current !== connected) {
      if (connected) focusConnectedTarget();
      else focusDisconnectedTarget();
    } else if (focusBelongedToSection.current && operationCompleted) {
      const preferredKey =
        operationCompletion.outcome === "Success" && operationCompletion.key.startsWith("remove:")
          ? undefined
          : operationCompletion.key;
      if (connected) focusConnectedTarget(preferredKey);
      else focusDisconnectedTarget();
    } else if (focusBelongedToSection.current && noticeEnded) {
      if (connected) focusConnectedTarget(previousNotice.key);
      else focusDisconnectedTarget();
    } else if (focusBelongedToSection.current && editorClosed) {
      if (connected) focusConnectedTarget(editorFocusKey(previousEditorValue));
      else focusDisconnectedTarget();
    }

    wasConnected.current = connected;
    previousOperationNotice.current = operationNotice;
    previousCompletionSequence.current = operationCompletion?.sequence ?? 0;
    previousEditor.current = editor;
  }, [connected, editor, operationCompletion, operationNotice, sectionId]);

  return {
    addButtonRef,
    connectionContentRef,
    discardEditButtonRef,
    operationStatusRef,
    unavailableStatusRef,
  };
}
