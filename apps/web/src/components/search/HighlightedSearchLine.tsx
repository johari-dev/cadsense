import type { ProjectContentMatch } from "@cadsense/contracts";
import { memo, useMemo } from "react";

interface Range {
  readonly start: number;
  readonly end: number;
}

function normalizeRanges(match: ProjectContentMatch): Range[] {
  const ranges = match.matchRanges
    .map((range) => ({
      start: Math.max(0, Math.min(match.lineContent.length, range.start)),
      end: Math.max(0, Math.min(match.lineContent.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .toSorted((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export const HighlightedSearchLine = memo(function HighlightedSearchLine(props: {
  readonly match: ProjectContentMatch;
}) {
  const ranges = useMemo(() => normalizeRanges(props.match), [props.match]);
  const output = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) {
      output.push(
        <span key={`${cursor}:${range.start}`}>
          {props.match.lineContent.slice(cursor, range.start)}
        </span>,
      );
    }
    output.push(
      <mark
        className="rounded-[2px] bg-primary/25 text-inherit"
        key={`${range.start}:${range.end}`}
      >
        {props.match.lineContent.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < props.match.lineContent.length) {
    output.push(<span key={`${cursor}:end`}>{props.match.lineContent.slice(cursor)}</span>);
  }
  return output;
});
