import { QuotesIcon } from "~/lib/icons";
import { useEffect, useMemo, useState } from "react";
import { useComposerHandleContext } from "~/composerHandleContext";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { toastManager } from "../ui/toast";

/** Rendered markdown of an assistant response; quotable text lies inside one. */
const ASSISTANT_RESPONSE_SELECTOR = '[data-message-role="assistant"] .chat-markdown';

interface AssistantSelection {
  /** The selected range clamped to the response; it keeps tracking the DOM. */
  readonly range: Range;
  /** The selection re-emitted as markdown source. */
  readonly markdown: string;
}

function closestAssistantResponse(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(ASSISTANT_RESPONSE_SELECTOR) ?? null;
}

/** The document selection when all of its text lies in one assistant response, else null. */
function readAssistantSelection(): AssistantSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const response =
    closestAssistantResponse(range.startContainer) ?? closestAssistantResponse(range.endContainer);
  if (!response) return null;
  // Clamp to the response. Triple-clicking its last block selects up to the
  // next row, which still counts as long as no text outside it is selected.
  const clamped = document.createRange();
  clamped.selectNodeContents(response);
  if (range.compareBoundaryPoints(Range.START_TO_START, clamped) > 0) {
    clamped.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, clamped) < 0) {
    clamped.setEnd(range.endContainer, range.endOffset);
  }
  if (clamped.toString().trim() !== range.toString().trim()) return null;
  const markdown = chatMarkdownClipboardPayload({
    rangeCount: 1,
    getRangeAt: () => clamped,
  })?.text.trim();
  return markdown ? { range: clamped, markdown } : null;
}

/** Zero-width rect at the end of the range's last line of text. */
function rangeEndRect(range: Range): DOMRect {
  const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
  const last = lines.at(-1) ?? range.getBoundingClientRect();
  return new DOMRect(last.right, last.top, 0, last.height);
}

/** Markdown blockquote of `markdown`, followed by a blank line for the reply. */
function quoteMarkdown(markdown: string): string {
  const quoted = markdown
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

/**
 * Floating "Reply" pill for text selected inside an assistant response.
 * Clicking it appends the selection to the composer as a quote and leaves the
 * caret after it, so the user can type feedback on that part. Mount once per
 * timeline; it listens to the document selection.
 */
export function QuoteReplyPill() {
  const composer = useComposerHandleContext();
  const [selection, setSelection] = useState<AssistantSelection | null>(null);

  useEffect(() => {
    // Hidden while the pointer is still dragging out a selection, so the pill
    // appears once where the selection ends instead of chasing the pointer.
    let pointerSelecting = false;
    const sync = () => setSelection(pointerSelecting ? null : readAssistantSelection());
    const onPointerDown = () => {
      pointerSelecting = true;
    };
    const onPointerUp = () => {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      sync();
    };
    document.addEventListener("selectionchange", sync);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
    };
  }, []);

  // Scrolling moves the selected text away from the pill, so hide it.
  useEffect(() => {
    if (!selection) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(selection.range.startContainer)) {
        setSelection(null);
      }
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [selection]);

  const anchor = useMemo(
    () => selection && { getBoundingClientRect: () => rangeEndRect(selection.range) },
    [selection],
  );

  const quoteIntoComposer = () => {
    if (!selection) return;
    const inserted =
      composer?.current?.insertTextAtEnd(quoteMarkdown(selection.markdown), {
        leadingBoundary: "paragraph",
      }) ?? false;
    if (!inserted) {
      toastManager.add({
        type: "error",
        title: "Unable to quote",
        description: "The chat isn't ready to accept input right now.",
      });
      return;
    }
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  return (
    <Popover
      open={selection !== null}
      onOpenChange={(open, { reason }) => {
        // The selection owns visibility. Presses elsewhere already update it,
        // and the click that ends a drag would otherwise count as outside.
        if (!open && reason === "escape-key") setSelection(null);
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        // End-aligned so the pointer, which rests where the drag ended, does not cover it.
        align="end"
        sideOffset={6}
        tooltipStyle
        viewportClassName="p-0"
        initialFocus={false}
        finalFocus={false}
      >
        <Button
          size="xs"
          variant="ghost"
          // Keep the selection; a press would otherwise collapse it before the click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={quoteIntoComposer}
        >
          <QuotesIcon />
          Reply
        </Button>
      </PopoverPopup>
    </Popover>
  );
}
