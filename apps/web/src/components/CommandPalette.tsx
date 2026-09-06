import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ComposerHandleContext } from "../composerHandleContext";
import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { CommandDialog, CommandDialogPopup } from "./ui/command";

/** Dedicated file tools retain their shortcuts independently of project creation. */
export function CommandPalette({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<"files" | "content" | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings);
      const next =
        command === "filePicker.toggle"
          ? "files"
          : command === "projectSearch.toggle"
            ? "content"
            : null;
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      setMode((current) => (current === next ? null : next));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
      >
        {children}
        <CommandDialogPopup
          aria-label={mode === "files" ? "File picker" : "Search project contents"}
          className={mode === "content" ? "h-105 overflow-hidden p-0" : "overflow-hidden p-0"}
          data-command-palette="true"
          finalFocus={() => {
            composerHandleRef.current?.focusAtEnd();
            return false;
          }}
        >
          {mode === "files" ? (
            <ProjectFilePicker
              setOpen={(open) => {
                if (!open) setMode(null);
              }}
            />
          ) : mode === "content" ? (
            <ProjectContentSearchDialog
              onOpenChange={(open) => {
                if (!open) setMode(null);
              }}
            />
          ) : null}
        </CommandDialogPopup>
      </CommandDialog>
    </ComposerHandleContext>
  );
}
