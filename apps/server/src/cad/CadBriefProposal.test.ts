import { CADSENSE_DESIGN_BRIEF_TEMPLATE, CadBriefProposalId } from "@cadsense/contracts";
import { stripDesignBriefComments } from "@cadsense/shared/designBrief";
import { describe, expect, it } from "vite-plus/test";
import { applyBriefProposal, checkBriefProposal } from "./CadBriefProposal.ts";

// Ways the rules can fail (CadDesignBriefSpec.md, "Ways proposals can fail"): an addition the
// student never said is accepted; quoting is so strict that a real quote with different case,
// spacing, apostrophes, or end punctuation is refused; a removal names a line the brief lacks; a
// proposal grows past the cap, is empty, repeats a dismissed line, or opens beside another one.
describe("checkBriefProposal", () => {
  const context = {
    userMessages: [
      "Review the shooter. Ignore the 84T belt, it’s just a placeholder until we pick the ratio.",
    ],
    briefLines: ["The shooter hood is fixed at 45 degrees."],
    open: false,
    dismissed: new Set<string>(),
  };
  const add = (text: string, quote: string) => ({ add: [{ text, quote }] });

  it("accepts a quote from a user message despite case, spacing, apostrophes, and end punctuation", () => {
    expect(
      checkBriefProposal(
        add(
          "The 84T belt is a placeholder until the team picks the ratio.",
          "  It's just a placeholder   until we pick the RATIO.",
        ),
        context,
      ),
    ).toBeNull();
  });

  it("refuses an addition whose quote no user message contains", () => {
    expect(
      checkBriefProposal(add("The belt is undersized.", "the belt looks undersized"), context),
    ).toMatch(/quote/i);
  });

  it("refuses a removal of a line the brief does not have", () => {
    expect(
      checkBriefProposal(
        { remove: [{ text: "The hood is fixed.", reason: "The user said it adjusts." }] },
        context,
      ),
    ).toMatch(/not a line/i);
    expect(
      checkBriefProposal(
        {
          remove: [{ text: "The shooter hood is fixed at 45 degrees.", reason: "It adjusts now." }],
        },
        context,
      ),
    ).toBeNull();
  });

  it("refuses an empty proposal and one over the line cap", () => {
    expect(checkBriefProposal({}, context)).toMatch(/nothing/i);
    const six = Array.from({ length: 6 }, (_, index) => ({
      text: `Line ${index}.`,
      quote: "just a placeholder",
    }));
    expect(checkBriefProposal({ add: six }, context)).toMatch(/at most 5/i);
  });

  it("refuses a line already in the brief, a dismissed line, and a second open proposal", () => {
    expect(
      checkBriefProposal(add("The shooter hood is fixed at 45 degrees.", "placeholder"), context),
    ).toMatch(/already/i);
    expect(
      checkBriefProposal(add("The 84T belt is a placeholder.", "just a placeholder"), {
        ...context,
        dismissed: new Set(["the 84t belt is a placeholder"]),
      }),
    ).toMatch(/dismissed/i);
    expect(
      checkBriefProposal(add("The 84T belt is a placeholder.", "just a placeholder"), {
        ...context,
        open: true,
      }),
    ).toMatch(/open/i);
  });
});

// Ways applying can fail: it drops text the student wrote after the proposal; it removes a line
// inside the template's comment or a line that only contains the removed text; it fails when the
// removed line is already gone; with no brief it writes the lines without the template.
describe("applyBriefProposal", () => {
  const card = (add: ReadonlyArray<string>, remove: ReadonlyArray<string>) => ({
    proposalId: CadBriefProposalId.make("p1"),
    path: "DESIGN.md",
    add: add.map((text) => ({ text, quote: "q" })),
    remove: remove.map((text) => ({ text, reason: "r" })),
  });

  it("appends to the brief as it is now and removes only the exact line", () => {
    const current =
      "# Shooter\n\nThe shooter hood is fixed at 45 degrees.\nThe shooter hood is fixed at 45 degrees, for now.\nA line the student added after the proposal.\n";
    expect(
      applyBriefProposal(
        current,
        card(["The 84T belt is a placeholder."], ["The shooter hood is fixed at 45 degrees."]),
      ),
    ).toBe(
      "# Shooter\n\nThe shooter hood is fixed at 45 degrees, for now.\nA line the student added after the proposal.\nThe 84T belt is a placeholder.\n",
    );
  });

  it("leaves the template comment alone and counts an already-removed line as done", () => {
    const current = `${CADSENSE_DESIGN_BRIEF_TEMPLATE}The hood adjusts.\n`;
    const next = applyBriefProposal(
      current,
      card(
        [],
        ["What moves, what does it ride on, and what is supposed to move with it?", "Gone."],
      ),
    );
    expect(next).toBe(current);
  });

  it("starts from the template when there is no brief, and the lines reach the reader", () => {
    const next = applyBriefProposal(null, card(["The 84T belt is a placeholder."], []));
    expect(next.startsWith(CADSENSE_DESIGN_BRIEF_TEMPLATE)).toBe(true);
    expect(stripDesignBriefComments(next)).toBe("The 84T belt is a placeholder.");
  });
});
