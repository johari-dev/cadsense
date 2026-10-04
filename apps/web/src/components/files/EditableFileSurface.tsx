import type { EnvironmentId } from "@cadsense/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData, setProjectFileQueryData } from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

/** Saves a file's edits after a pause in typing, reporting when a save is pending. */
export function useFileSaveCoordinator(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const coordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => input.onPendingChange(input.relativePath, pending),
        persist: (contents) =>
          writeFile({
            environmentId: input.environmentId,
            input: { cwd: input.cwd, relativePath: input.relativePath, contents },
          }),
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(input.environmentId, input.cwd, input.relativePath, contents),
      }),
    [input.cwd, input.environmentId, input.onPendingChange, input.relativePath, writeFile],
  );
  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
}

function lineOffset(contents: string, line: number): number {
  if (line <= 1) return 0;
  let cursor = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const next = contents.indexOf("\n", cursor);
    if (next < 0) return contents.length;
    cursor = next + 1;
  }
  return cursor;
}

/** The text editor for a workspace file. Edits save on their own; `revealLine` moves the caret. */
export function EditableFileSurface(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  contents: string;
  revealLine: number | null;
  revealRequestId: number;
  wordWrap: boolean;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}) {
  const [contents, setContents] = useState(props.contents);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const save = useFileSaveCoordinator(props);
  // A reveal request focuses the editor on its line once. While the text then loads or refreshes
  // (replacing the value moves the caret to the end), it keeps the caret there, but only while the
  // editor still has focus and the person hasn't taken over by typing, clicking, scrolling or moving
  // the caret.
  const revealedRequest = useRef<number | null>(null);
  const handledRequest = useRef<number | null>(null);
  useEffect(() => setContents(props.contents), [props.contents, props.relativePath]);
  useEffect(() => {
    if (props.revealLine === null || handledRequest.current === props.revealRequestId) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const first = revealedRequest.current !== props.revealRequestId;
    if (!first && document.activeElement !== textarea) return;
    revealedRequest.current = props.revealRequestId;
    const offset = lineOffset(contents, props.revealLine);
    textarea.setSelectionRange(offset, offset);
    if (!first) return;
    textarea.focus({ preventScroll: true });
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(
      0,
      (props.revealLine - 1) * lineHeight - textarea.clientHeight / 2,
    );
  }, [contents, props.revealLine, props.revealRequestId]);
  const takeOver = () => {
    handledRequest.current = props.revealRequestId;
  };

  return (
    <textarea
      ref={textareaRef}
      aria-label={`Edit ${props.relativePath}`}
      className={cn(
        "min-h-0 flex-1 resize-none border-0 bg-code-background p-4 font-mono text-code-foreground outline-none",
        props.wordWrap ? "whitespace-pre-wrap" : "whitespace-pre overflow-x-auto",
      )}
      spellCheck={false}
      value={contents}
      wrap={props.wordWrap ? "soft" : "off"}
      onKeyDown={takeOver}
      onPointerDown={takeOver}
      onWheel={takeOver}
      onChange={(event) => {
        takeOver();
        const next = event.currentTarget.value;
        setContents(next);
        setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, next);
        save.change(next);
      }}
    />
  );
}
