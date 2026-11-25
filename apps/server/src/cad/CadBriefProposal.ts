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
  type OrchestrationThread,
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
  /** Whether this chat already has a proposal the student has not decided. */
  readonly open: boolean;
  /** Folded text of lines from proposals the student dismissed in this chat. */
  readonly dismissed: ReadonlySet<string>;
}

/**
 * Why a proposal cannot be shown, written for the agent, or null when it can. An addition must
 * quote one of the user's messages in this chat, so the agent cannot present its own reading of
 * the model as the student's intent.
 */
export const checkBriefProposal = (
  input: CadBriefProposeInput,
  context: BriefProposalContext,
): string | null => {
  const add = input.add ?? [];
  const remove = input.remove ?? [];
  if (context.open)
    return "This chat already has an open brief proposal. Wait for the student to save or dismiss it.";
  if (add.length + remove.length === 0) return "The proposal has nothing to add or remove.";
  if (add.length + remove.length > CAD_BRIEF_PROPOSAL_MAX_LINES)
    return `Propose at most ${CAD_BRIEF_PROPOSAL_MAX_LINES} lines at a time.`;
  const messages = context.userMessages.map(foldBriefText);
  const briefLines = new Set(context.briefLines.map(foldBriefText));
  for (const line of add) {
    const quote = foldBriefText(line.quote);
    if (quote.length === 0 || !messages.some((message) => message.includes(quote)))
      return `The quote for "${line.text}" is not in any of the user's messages in this chat. Quote the user's own words, or do not propose the line.`;
    if (briefLines.has(foldBriefText(line.text))) return `"${line.text}" is already in the brief.`;
  }
  for (const line of remove)
    if (!context.briefLines.includes(line.text))
      return `"${line.text}" is not a line of the current brief. Copy the line exactly as cad_context's brief shows it.`;
  for (const line of [...add, ...remove])
    if (context.dismissed.has(foldBriefText(line.text)))
      return `The student dismissed "${line.text}" in this chat. Do not propose it again.`;
  return null;
};

/**
 * The brief after saving a proposal, applied to the file as it is now so the student's own later
 * edits stay. Removed lines go only where a whole line outside a comment matches exactly; one that
 * is already gone counts as done. Added lines go at the end. With no file, it starts from the
 * template, as the app's entry points do.
 */
export const applyBriefProposal = (current: string | null, card: CadBriefProposalCard) => {
  const removed = new Set(card.remove.map((line) => line.text));
  let inComment = false;
  const kept = (current ?? CADSENSE_DESIGN_BRIEF_TEMPLATE).split("\n").filter((line) => {
    const removable = !inComment && !line.includes("<!--") && removed.has(line.trim());
    const open = line.lastIndexOf("<!--");
    const close = line.lastIndexOf("-->");
    if (open > close) inComment = true;
    else if (close > open) inComment = false;
    return !removable;
  });
  const text = kept.join("\n");
  if (card.add.length === 0) return text;
  return `${text.endsWith("\n") || text.length === 0 ? text : `${text}\n`}${card.add
    .map((line) => line.text)
    .join("\n")}\n`;
};

const decodeCard = Schema.decodeUnknownOption(CadBriefProposalCard);
const decodeResolved = Schema.decodeUnknownOption(CadBriefProposalResolved);

/** The proposals in a chat and the student's decision on each, from its activities. */
export const briefProposalsOf = (thread: Pick<OrchestrationThread, "activities">) => {
  const cards = new Map<CadBriefProposalId, CadBriefProposalCard>();
  const outcomes = new Map<CadBriefProposalId, CadBriefProposalOutcome>();
  for (const activity of thread.activities) {
    if (activity.kind === CAD_BRIEF_PROPOSED_ACTIVITY) {
      const card = decodeCard(activity.payload);
      if (Option.isSome(card)) cards.set(card.value.proposalId, card.value);
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
      for (const line of [...card.add, ...card.remove]) dismissed.add(foldBriefText(line.text));
  return {
    cards,
    outcomes,
    open: [...cards.keys()].some((id) => !outcomes.has(id)),
    dismissed,
  };
};
