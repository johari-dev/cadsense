import {
  MessageRatingReason,
  type MessageId,
  type MessageRating,
  type ScopedThreadRef,
} from "@cadsense/contracts";
import { ThumbsDownIcon, ThumbsUpIcon, type LucideIcon } from "lucide-react";
import { memo, useRef, useState, type Ref } from "react";

import { cn } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REASON_LABELS = {
  incorrect: "Incorrect",
  "ignored-instructions": "Didn't follow instructions",
  "too-long": "Too long",
  other: "Other",
} satisfies Record<MessageRatingReason, string>;

/**
 * Thumbs up and down for a completed assistant response, rendered as direct
 * children of the hover-revealed meta row. Clicking a thumb sets that rating
 * and clicking the active one clears it. A thumbs down saves right away, then
 * asks for an optional reason; dismissing that popover keeps the rating.
 * The active thumb carries `data-persistent` so the row keeps it visible.
 */
export const MessageRatingButtons = memo(function MessageRatingButtons({
  threadRef,
  messageId,
  rating,
}: {
  threadRef: ScopedThreadRef;
  messageId: MessageId;
  rating: MessageRating | undefined;
}) {
  const setMessageRating = useAtomCommand(threadEnvironment.setMessageRating);
  const thumbsDownRef = useRef<HTMLButtonElement>(null);
  const [askingReason, setAskingReason] = useState(false);
  const save = (next: MessageRating | null) => {
    void setMessageRating({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, messageId, rating: next },
    });
  };

  return (
    <>
      <RatingButton
        icon={ThumbsUpIcon}
        label="Good response"
        active={rating?.value === "up"}
        onClick={() => save(rating?.value === "up" ? null : { value: "up" })}
      />
      <RatingButton
        ref={thumbsDownRef}
        icon={ThumbsDownIcon}
        label="Bad response"
        active={rating?.value === "down"}
        onClick={() => {
          if (rating?.value === "down") {
            save(null);
            return;
          }
          save({ value: "down" });
          setAskingReason(true);
        }}
      />
      <Popover open={askingReason} onOpenChange={setAskingReason}>
        <PopoverPopup anchor={thumbsDownRef} side="bottom" align="start" className="w-80">
          <RatingReasonForm
            onSubmit={(details) => {
              save({ value: "down", ...details });
              setAskingReason(false);
            }}
          />
        </PopoverPopup>
      </Popover>
    </>
  );
});

function RatingButton({
  ref,
  icon: Icon,
  label,
  active,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            aria-label={label}
            aria-pressed={active}
            data-persistent={active ? "" : undefined}
            onClick={onClick}
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Icon className={cn("size-3", active && "fill-current text-primary")} />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{active ? "Remove rating" : label}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Optional details for a thumbs down. Sending needs a reason or a note. */
function RatingReasonForm({
  onSubmit,
}: {
  onSubmit: (details: { reason?: MessageRatingReason; note?: string }) => void;
}) {
  const [reason, setReason] = useState<MessageRatingReason | null>(null);
  const [note, setNote] = useState("");
  const trimmedNote = note.trim();

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          ...(reason !== null ? { reason } : {}),
          ...(trimmedNote ? { note: trimmedNote } : {}),
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <PopoverTitle className="text-sm">What went wrong?</PopoverTitle>
        <PopoverDescription className="text-xs">
          Optional. The thumbs down is already saved.
        </PopoverDescription>
      </div>
      <div role="group" aria-label="Reason" className="flex flex-wrap gap-1.5">
        {MessageRatingReason.literals.map((value) => (
          <Toggle
            key={value}
            size="compact"
            variant="outline"
            pressed={reason === value}
            onPressedChange={(pressed) => setReason(pressed ? value : null)}
          >
            {REASON_LABELS[value]}
          </Toggle>
        ))}
      </div>
      <Input
        size="compact"
        aria-label="Note"
        placeholder="Add a note"
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <Button
        type="submit"
        size="xs"
        className="self-end"
        disabled={reason === null && trimmedNote === ""}
      >
        Send
      </Button>
    </form>
  );
}
