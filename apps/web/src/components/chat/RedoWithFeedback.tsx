import { useRef, useState } from "react";
import { ArrowClockwiseIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FEEDBACK_CHIPS = ["Too long", "Wrong approach", "Missed something", "More detail"] as const;
const ENDS_WITH_PUNCTUATION = /[.!?]$/;

/** Appends a chip phrase as its own sentence, so chips combine with typed text. */
function appendFeedbackPhrase(feedback: string, phrase: string): string {
  const current = feedback.trimEnd();
  if (current === "") return `${phrase}. `;
  return `${current}${ENDS_WITH_PUNCTUATION.test(current) ? "" : "."} ${phrase}. `;
}

/** The user message sent for the redo, e.g. "Feedback on your last response: Too long. Please redo it." */
function formatRedoFeedbackPrompt(feedback: string): string {
  const sentence = feedback.trim();
  const terminated = ENDS_WITH_PUNCTUATION.test(sentence) ? sentence : `${sentence}.`;
  return `Feedback on your last response: ${terminated} Please redo it.`;
}

/** Meta-row toggle for the inline feedback box under the latest response. */
export function RedoWithFeedbackButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Redo with feedback"
            aria-expanded={open}
            onClick={onToggle}
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ArrowClockwiseIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>
        <p>Redo with feedback</p>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Inline feedback box shown under the latest response. Enter sends the
 * formatted prompt through `onSubmit`, Shift+Enter adds a line, Esc closes.
 * The box stays open if the send is refused; it unmounts once a turn starts.
 */
export function RedoFeedbackForm({
  onSubmit,
  onClose,
}: {
  onSubmit: (prompt: string) => void;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = feedback.trim() !== "";
  const submit = () => {
    if (canSubmit) onSubmit(formatRedoFeedbackPrompt(feedback));
  };

  return (
    <form
      className="mt-2 rounded-xl border border-border bg-card/70 p-2 focus-within:border-ring/50"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        autoFocus
        aria-label="Feedback on this response"
        placeholder="What should change?"
        rows={1}
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        className="field-sizing-content max-h-40 min-h-8 w-full resize-none bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <div role="group" aria-label="Quick feedback" className="flex flex-wrap gap-1">
          {FEEDBACK_CHIPS.map((chip) => (
            <Button
              key={chip}
              type="button"
              size="xs"
              variant="outline"
              className="rounded-full before:rounded-full"
              onClick={() => {
                setFeedback((current) => appendFeedbackPhrase(current, chip));
                textareaRef.current?.focus();
              }}
            >
              {chip}
            </Button>
          ))}
        </div>
        <div className="ms-auto flex items-center gap-1">
          <Button type="button" size="xs" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="xs" disabled={!canSubmit}>
            Redo
          </Button>
        </div>
      </div>
    </form>
  );
}
