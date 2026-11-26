import {
  CAD_BRIEF_PROPOSAL_MAX_LINES,
  CAD_BRIEF_PROPOSAL_RESOLVED_ACTIVITY,
  CAD_BRIEF_PROPOSED_ACTIVITY,
  CADSENSE_DESIGN_BRIEF_TEMPLATE,
  CadBriefProposalCard,
  CadBriefProposalResolved,
  type CadBriefProposalId,
  type CadBriefProposalOutcome,
  type CadBriefProposeInput,
  type TurnId,
} from "@cadsense/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/*
 * Rules for agent proposals to the design brief ("Agent proposals" in CadDesignBriefSpec.md).
 * CadViewing runs them for `cad_brief_propose` and for the student's save or dismiss.
 */

/**
 * Text folded for comparing a quote with what the user wrote: case, runs of whitespace, curly
 * quotes, and end punctuation do not matter.
 */
export const foldBriefText = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[‘’]/g, "'")
    .replaceAll(/[“”]/g, '"')
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/^["'.,;:!?\s]+|["'.,;:!?\s]+$/g, "");

/** What a new proposal is checked against. */
export interface BriefProposalContext {
  /** Text of the user's messages in this chat. */
  readonly userMessages: ReadonlyArray<string>;
  /** Non-empty lines of the brief as agents read it (comments removed), trimmed. */
  readonly briefLines: ReadonlyArray<string>;
  /** Folded text of lines from proposals the student dismissed in this chat. */
  readonly dismissed: ReadonlySet<string>;
}

/** How many times `text` occurs inside the brief's lines; a match never spans two lines. */
const occurrences = (lines: ReadonlyArray<string>, text: string) =>
  lines.reduce((count, line) => count + line.split(text).length - 1, 0);

/**
 * Why a proposal cannot be shown, written for the agent, or null when it can. Every addition and
 * replacement must quote one of the user's messages in this chat, so the agent cannot present its
 * own reading of the model as the student's intent. Removed and replaced text must occur exactly
 * once in the brief, a whole line or a sentence within one, so a stale sentence changes without
 * the agent restating the true ones beside it.
 */
export const checkBriefProposal = (
  input: CadBriefProposeInput,
  context: BriefProposalContext,
): string | null => {
  const add = input.add ?? [];
  const remove = input.remove ?? [];
  const replace = input.replace ?? [];
  const total = add.length + remove.length + replace.length;
  if (total === 0) return "The proposal has nothing to add, remove, or replace.";
  if (total > CAD_BRIEF_PROPOSAL_MAX_LINES)
    return `Propose at most ${CAD_BRIEF_PROPOSAL_MAX_LINES} changes at a time.`;
  const messages = context.userMessages.map(foldBriefText);
  const quoted = (quote: string) => {
    const folded = foldBriefText(quote);
    return folded.length > 0 && messages.some((message) => message.includes(folded));
  };
  const briefLines = new Set(context.briefLines.map(foldBriefText));
  const existing = (text: string) => {
    const count = occurrences(context.briefLines, text);
    return count === 0
      ? `"${text}" is not in the current brief. Copy a whole line or one sentence of it exactly as cad_context's brief shows it.`
      : count > 1
        ? `"${text}" appears more than once in the brief. Include more of the sentence so it matches one place.`
        : null;
  };
  for (const line of add) {
    if (!quoted(line.quote))
      return `The quote for "${line.text}" is not in any of the user's messages in this chat. Quote the user's own words, or do not propose the line.`;
    if (briefLines.has(foldBriefText(line.text))) return `"${line.text}" is already in the brief.`;
  }
  for (const line of remove) {
    const problem = existing(line.text);
    if (problem) return problem;
  }
  for (const change of replace) {
    const problem = existing(change.from);
    if (problem) return problem;
    if (!quoted(change.quote))
      return `The quote for changing "${change.from}" is not in any of the user's messages in this chat. Quote the user's own words, or do not propose the change.`;
  }
  for (const text of [
    ...add.map((line) => line.text),
    ...remove.map((line) => line.text),
    ...replace.map((change) => change.to),
  ])
    if (context.dismissed.has(foldBriefText(text)))
      return `The student dismissed "${text}" in this chat. Do not propose it again.`;
  return null;
};

/**
 * The changes a new proposal shows when the chat already has an undecided one: the open card's
 * changes first, then the new ones. A line both carry appears once, and a newer change to the same
 * sentence replaces the older one. Students often ignore a card and keep talking, so a later fact
 * must not be lost to an earlier card nobody decided.
 */
export const mergeBriefProposals = (
  open: CadBriefProposalCard | null,
  input: CadBriefProposeInput,
): Required<CadBriefProposeInput> => {
  const add = [...(open?.add ?? [])];
  for (const line of input.add ?? [])
    if (!add.some((kept) => foldBriefText(kept.text) === foldBriefText(line.text))) add.push(line);
  const remove = [...(open?.remove ?? [])];
  for (const line of input.remove ?? [])
    if (!remove.some((kept) => kept.text === line.text)) remove.push(line);
  const newer = input.replace ?? [];
  const replace = [
    ...(open?.replace ?? []).filter((change) => !newer.some((next) => next.from === change.from)),
    ...newer,
  ];
  return { add, remove, replace };
};

/**
 * Replaces the first occurrence of `from` in a line with `to`. An empty `to` removes it along with
 * the space that separated it from its neighbors, and a line left empty is dropped (null).
 */
const editLine = (line: string, from: string, to: string): string | null => {
  const at = line.indexOf(from);
  const before = line.slice(0, at);
  const after = line.slice(at + from.length);
  if (to.length > 0) return `${before}${to}${after}`;
  const kept = `${before.trimEnd()}${before.trim() && after.trim() ? " " : ""}${after.trimStart()}`;
  return kept.trim().length === 0 ? null : kept;
};

/**
 * The brief after saving a proposal, applied to the file as it is now so the student's own later
 * edits stay. Removals and replacements change their text where it first occurs outside a comment;
 * one whose text is already gone is skipped. Added lines go at the end. With no file, it starts
 * from the template, as the app's entry points do.
 */
export const applyBriefProposal = (current: string | null, card: CadBriefProposalCard) => {
  const edits = [
    ...card.remove.map((line) => ({ from: line.text, to: "" })),
    ...card.replace.map((change) => ({ from: change.from, to: change.to })),
  ];
  const lines: Array<string | null> = (current ?? CADSENSE_DESIGN_BRIEF_TEMPLATE).split("\n");
  const editable: Array<boolean> = [];
  let inComment = false;
  for (const line of lines as Array<string>) {
    editable.push(!inComment && !line.includes("<!--"));
    const open = line.lastIndexOf("<!--");
    const close = line.lastIndexOf("-->");
    if (open > close) inComment = true;
    else if (close > open) inComment = false;
  }
  for (const edit of edits) {
    const index = lines.findIndex((line, i) => editable[i] && line?.includes(edit.from));
    if (index >= 0) lines[index] = editLine(lines[index]!, edit.from, edit.to);
  }
  const text = lines.filter((line) => line !== null).join("\n");
  if (card.add.length === 0) return text;
  return `${text.endsWith("\n") || text.length === 0 ? text : `${text}\n`}${card.add
    .map((line) => line.text)
    .join("\n")}\n`;
};

const decodeCard = Schema.decodeUnknownOption(CadBriefProposalCard);
const decodeResolved = Schema.decodeUnknownOption(CadBriefProposalResolved);

/**
 * The proposals in a chat and the student's decision on each, from every proposal activity of the
 * chat (readCadBriefActivities), oldest first.
 */
export const briefProposalsOf = (
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly turnId: TurnId | null;
    readonly payload: unknown;
  }>,
) => {
  const cards = new Map<CadBriefProposalId, CadBriefProposalCard>();
  const turnIds = new Map<CadBriefProposalId, TurnId | null>();
  const outcomes = new Map<CadBriefProposalId, CadBriefProposalOutcome>();
  for (const activity of activities) {
    if (activity.kind === CAD_BRIEF_PROPOSED_ACTIVITY) {
      const card = decodeCard(activity.payload);
      if (Option.isSome(card)) {
        cards.set(card.value.proposalId, card.value);
        turnIds.set(card.value.proposalId, activity.turnId);
      }
    } else if (activity.kind === CAD_BRIEF_PROPOSAL_RESOLVED_ACTIVITY) {
      const resolved = decodeResolved(activity.payload);
      // The first decision stands; resolve never records a second one.
      if (Option.isSome(resolved) && !outcomes.has(resolved.value.proposalId))
        outcomes.set(resolved.value.proposalId, resolved.value.outcome);
    }
  }
  const dismissed = new Set<string>();
  for (const [id, card] of cards)
    if (outcomes.get(id) === "dismissed")
      for (const text of [
        ...card.add.map((line) => line.text),
        ...card.remove.map((line) => line.text),
        ...card.replace.map((change) => change.to),
      ])
        dismissed.add(foldBriefText(text));
  return {
    cards,
    /** The turn each proposal was made in, so its decision is filed under the same turn. */
    turnIds,
    outcomes,
    /** The card still waiting for the student. A new proposal folds into it, so there is one. */
    open: [...cards.values()].findLast((card) => !outcomes.has(card.proposalId)) ?? null,
    dismissed,
  };
};
