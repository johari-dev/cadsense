import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/*
 * Agent proposals to change the project design brief. The agent calls `cad_brief_propose`, the
 * chat shows the proposal as a card, and the student saves or dismisses it. See "Agent proposals"
 * in apps/server/src/cad/CadDesignBriefSpec.md.
 */

/** Most lines one proposal may add and remove together. */
export const CAD_BRIEF_PROPOSAL_MAX_LINES = 5;

const BriefLine = TrimmedNonEmptyString.check(Schema.isMaxLength(300));

export const CadBriefAddition = Schema.Struct({
  /** The sentence to add, in plain words. */
  text: BriefLine,
  /** The user's own words it comes from, copied from one of their messages in this chat. */
  quote: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type CadBriefAddition = typeof CadBriefAddition.Type;

export const CadBriefRemoval = Schema.Struct({
  /** A line of the current brief, exactly as it reads. */
  text: BriefLine,
  /** What the user said, or what changed in the model, that makes the line wrong. */
  reason: BriefLine,
});
export type CadBriefRemoval = typeof CadBriefRemoval.Type;

export const CadBriefProposeInput = Schema.Struct({
  add: Schema.optionalKey(Schema.Array(CadBriefAddition)),
  remove: Schema.optionalKey(Schema.Array(CadBriefRemoval)),
});
export type CadBriefProposeInput = typeof CadBriefProposeInput.Type;

export const CadBriefProposalId = TrimmedNonEmptyString.pipe(Schema.brand("CadBriefProposalId"));
export type CadBriefProposalId = typeof CadBriefProposalId.Type;

/** The proposal as the chat shows it: the `cad.brief.proposed` activity payload. */
export const CadBriefProposalCard = Schema.Struct({
  proposalId: CadBriefProposalId,
  /** Workspace-relative brief path the proposal applies to. */
  path: Schema.String,
  add: Schema.Array(CadBriefAddition),
  remove: Schema.Array(CadBriefRemoval),
});
export type CadBriefProposalCard = typeof CadBriefProposalCard.Type;

export const CadBriefProposalOutcome = Schema.Literals(["saved", "dismissed"]);
export type CadBriefProposalOutcome = typeof CadBriefProposalOutcome.Type;

/** The student's decision: the `cad.brief.proposal-resolved` activity payload. */
export const CadBriefProposalResolved = Schema.Struct({
  proposalId: CadBriefProposalId,
  outcome: CadBriefProposalOutcome,
});
export type CadBriefProposalResolved = typeof CadBriefProposalResolved.Type;

export const CAD_BRIEF_PROPOSED_ACTIVITY = "cad.brief.proposed";
export const CAD_BRIEF_PROPOSAL_RESOLVED_ACTIVITY = "cad.brief.proposal-resolved";

export const CadBriefProposalResolveInput = Schema.Struct({
  threadId: ThreadId,
  proposalId: CadBriefProposalId,
  decision: Schema.Literals(["save", "dismiss"]),
});
export type CadBriefProposalResolveInput = typeof CadBriefProposalResolveInput.Type;

export const CadBriefProposalResolveResult = Schema.Struct({
  outcome: CadBriefProposalOutcome,
  /** Workspace-relative brief path. */
  path: Schema.String,
  /** The brief this call wrote, so the editor can show it; null when it wrote nothing. */
  contents: Schema.NullOr(Schema.String),
});
export type CadBriefProposalResolveResult = typeof CadBriefProposalResolveResult.Type;
