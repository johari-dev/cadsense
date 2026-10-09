import * as React from "react";
import * as Schema from "effect/Schema";

export class ClipboardApiUnavailableError extends Schema.TaggedErrorClass<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedErrorClass<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

export class ClipboardReadUnavailableError extends Schema.TaggedErrorClass<ClipboardReadUnavailableError>()(
  "ClipboardReadUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while reading ${this.target}.`;
  }
}

export class ClipboardReadError extends Schema.TaggedErrorClass<ClipboardReadError>()(
  "ClipboardReadError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.target} from the clipboard.`;
  }
}

/**
 * Copies `value` as plain text. Call it straight from the click (or key press) that asked
 * for the copy: browsers only expose `navigator.clipboard` in secure contexts (https or
 * localhost), so over plain http on another address, such as a LAN or Tailscale IP, this
 * falls back to the legacy copy command, which only works during a user gesture.
 */
export async function writeTextToClipboard(value: string, target = "text") {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    (!navigator.clipboard?.writeText && typeof document === "undefined")
  ) {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!value) return false;

  try {
    // The fallback runs before any await, so it stays inside the caller's user gesture.
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else copyWithSelection(value);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError({
      target,
      cause,
    });
  }
}

/**
 * Copies through a hidden textarea and `document.execCommand("copy")`, then gives focus
 * and the selection back to whatever had them, so a copy button doesn't pull focus out of
 * the composer. Throws when the browser refuses the command.
 */
function copyWithSelection(value: string) {
  const active = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
    : [];
  // A Range is always ordered start to end, so a backward selection is restored from its
  // anchor and focus instead. Otherwise Shift+Arrow afterwards would move the wrong edge.
  const anchor = selection?.anchorNode
    ? { node: selection.anchorNode, offset: selection.anchorOffset }
    : null;
  const focus = selection?.focusNode
    ? { node: selection.focusNode, offset: selection.focusOffset }
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  // Read-only keeps mobile keyboards closed; 12pt keeps iOS from zooming on focus.
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:12pt;pointer-events:none";
  document.body.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    if (!document.execCommand("copy")) throw new Error("The browser refused the copy command.");
  } finally {
    textarea.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    // Inputs and textareas keep their own selection, which focus() brings back. Resetting
    // the document selection would collapse it, so only restore it for everything else.
    const isTextField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (selection && !isTextField) {
      if (ranges.length === 1 && anchor && focus) {
        selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      } else {
        // Firefox can hold several ranges (table cells), which have no single direction.
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
}

export async function readTextFromClipboard(target = "text"): Promise<string> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.readText
  ) {
    throw new ClipboardReadUnavailableError({
      target,
    });
  }

  try {
    return await navigator.clipboard.readText();
  } catch (cause) {
    throw new ClipboardReadError({
      target,
      cause,
    });
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        console.error(error);
        onErrorRef.current?.(error, ctx);
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
