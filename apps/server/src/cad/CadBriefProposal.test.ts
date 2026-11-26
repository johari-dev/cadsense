import { CADSENSE_DESIGN_BRIEF_TEMPLATE, CadBriefProposalId } from "@cadsense/contracts";
import { stripDesignBriefComments } from "@cadsense/shared/designBrief";
import { describe, expect, it } from "vite-plus/test";
import { applyBriefProposal, checkBriefProposal, mergeBriefProposals } from "./CadBriefProposal.ts";

// Ways the rules can fail (CadDesignBriefSpec.md, "Ways proposals can fail"): an addition the
// student never said is accepted; quoting is so strict that a real quote with different case,
// spacing, apostrophes, or end punctuation is refused; a removal names a line the brief lacks; a
// proposal grows past the cap, is empty, or repeats a dismissed line.
describe("checkBriefProposal", () => {
  const context = {
    userMessages: [
      "Review the shooter. Ignore the 84T belt, it’s just a placeholder until we pick the ratio.",
    ],
    briefLines: ["The shooter hood is fixed at 45 degrees."],
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
    ).toMatch(/not in the current brief/i);
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

  it("refuses a line already in the brief and a dismissed line", () => {
    expect(
      checkBriefProposal(add("The shooter hood is fixed at 45 degrees.", "placeholder"), context),
    ).toMatch(/already/i);
    expect(
      checkBriefProposal(add("The 84T belt is a placeholder.", "just a placeholder"), {
        ...context,
        dismissed: new Set(["the 84t belt is a placeholder"]),
      }),
    ).toMatch(/dismissed/i);
  });
});

// Ways sentence edits can fail (proposal eval, "Contradiction"): a stale sentence that shares a
// line with true ones can only be removed with the whole line; a replacement or removal names text
// the brief lacks, or text that appears twice so the wrong copy changes; a replacement the student
// never asked for is accepted; replacements slip past the cap or come back after a dismissal.
describe("checkBriefProposal with sentences", () => {
  const paragraph =
    "Transfer for our 2013 robot. It uses 2 inch rollers and a Vortex. The disc comes in at an angle.";
  const context = {
    userMessages: ["Can you review my transfer? We switched it to 3 inch rollers last week."],
    briefLines: [paragraph, "Rollers turn together. It uses 2 inch rollers and a Vortex."],
    dismissed: new Set<string>(),
  };
  const replace = (from: string, to: string, quote = "we switched it to 3 inch rollers") => ({
    replace: [{ from, to, quote }],
  });

  it("accepts a sentence inside a line for removal and replacement when it appears once", () => {
    const once = { ...context, briefLines: [paragraph] };
    expect(
      checkBriefProposal(
        replace("It uses 2 inch rollers and a Vortex.", "It uses 3 inch rollers and a Vortex."),
        once,
      ),
    ).toBeNull();
    expect(
      checkBriefProposal(
        { remove: [{ text: "The disc comes in at an angle.", reason: "r" }] },
        once,
      ),
    ).toBeNull();
  });

  it("refuses text the brief lacks and text that appears more than once", () => {
    expect(
      checkBriefProposal(replace("It uses 2 inch wheels.", "It uses 3 inch wheels."), context),
    ).toMatch(/not in the current brief/i);
    expect(
      checkBriefProposal(
        replace("It uses 2 inch rollers and a Vortex.", "It uses 3 inch rollers and a Vortex."),
        context,
      ),
    ).toMatch(/more than once/i);
  });

  it("refuses a replacement whose quote the student never wrote", () => {
    expect(
      checkBriefProposal(
        replace(
          "The disc comes in at an angle.",
          "The disc comes in flat.",
          "the disc comes in flat",
        ),
        context,
      ),
    ).toMatch(/quote/i);
  });

  it("counts replacements toward the cap and refuses a dismissed one", () => {
    const many = {
      replace: Array.from({ length: 6 }, () => ({
        from: "The disc comes in at an angle.",
        to: "x",
        quote: "3 inch rollers",
      })),
    };
    expect(checkBriefProposal(many, context)).toMatch(/at most 5/i);
    expect(
      checkBriefProposal(replace("The disc comes in at an angle.", "It uses 3 inch rollers."), {
        ...context,
        dismissed: new Set(["it uses 3 inch rollers"]),
      }),
    ).toMatch(/dismissed/i);
  });
});

// Ways applying can fail: it drops text the student wrote after the proposal; it removes a line
// inside the template's comment or a line that only contains the removed text; it fails when the
// removed line is already gone; with no brief it writes the lines without the template.
describe("applyBriefProposal", () => {
  const card = (
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>,
    replace: ReadonlyArray<readonly [string, string]> = [],
  ) => ({
    proposalId: CadBriefProposalId.make("p1"),
    path: "DESIGN.md",
    add: add.map((text) => ({ text, quote: "q" })),
    remove: remove.map((text) => ({ text, reason: "r" })),
    replace: replace.map(([from, to]) => ({ from, to, quote: "q" })),
  });

  it("changes only the named sentence inside a line and keeps the rest of the line", () => {
    const current =
      "# Transfer\n\nTransfer for our 2013 robot. It uses 2 inch rollers and a Vortex. The disc comes in at an angle.\n";
    expect(
      applyBriefProposal(
        current,
        card(
          [],
          [],
          [["It uses 2 inch rollers and a Vortex.", "It uses 3 inch rollers and a Vortex."]],
        ),
      ),
    ).toBe(
      "# Transfer\n\nTransfer for our 2013 robot. It uses 3 inch rollers and a Vortex. The disc comes in at an angle.\n",
    );
    expect(applyBriefProposal(current, card([], ["It uses 2 inch rollers and a Vortex."]))).toBe(
      "# Transfer\n\nTransfer for our 2013 robot. The disc comes in at an angle.\n",
    );
    expect(applyBriefProposal(current, card([], ["The disc comes in at an angle."]))).toBe(
      "# Transfer\n\nTransfer for our 2013 robot. It uses 2 inch rollers and a Vortex.\n",
    );
  });

  it("skips a replacement whose sentence the student already changed", () => {
    const current = "It uses 4 inch rollers now.\n";
    expect(
      applyBriefProposal(
        current,
        card([], [], [["It uses 2 inch rollers.", "It uses 3 inch rollers."]]),
      ),
    ).toBe(current);
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

// A student often ignores a card and keeps talking. Ways folding a new proposal into the open one
// can fail: an earlier line is lost, a line both proposals carry appears twice, an older change to
// the same sentence wins over the newer one, or the merged card grows past the cap.
describe("mergeBriefProposals", () => {
  const open = {
    proposalId: CadBriefProposalId.make("open"),
    path: "DESIGN.md",
    add: [{ text: "The belly pan is a placeholder.", quote: "its a placeholder" }],
    remove: [],
    replace: [{ from: "It uses 2 inch rollers.", to: "It uses 3 inch rollers.", quote: "3 inch" }],
  };

  it("keeps the open card's changes and adds the new ones after them", () => {
    expect(
      mergeBriefProposals(open, {
        add: [{ text: "The side plates are polycarb.", quote: "polycarb" }],
      }),
    ).toEqual({
      add: [open.add[0], { text: "The side plates are polycarb.", quote: "polycarb" }],
      remove: [],
      replace: open.replace,
    });
  });

  it("drops a repeated line and lets the newer change to the same sentence win", () => {
    const merged = mergeBriefProposals(open, {
      add: [{ text: "the belly pan is a placeholder", quote: "placeholder" }],
      replace: [
        { from: "It uses 2 inch rollers.", to: "It uses 4 inch rollers.", quote: "4 inch" },
      ],
    });
    expect(merged.add).toEqual(open.add);
    expect(merged.replace).toEqual([
      { from: "It uses 2 inch rollers.", to: "It uses 4 inch rollers.", quote: "4 inch" },
    ]);
  });

  it("is the new proposal alone when no card is open", () => {
    expect(mergeBriefProposals(null, { remove: [{ text: "Old.", reason: "r" }] })).toEqual({
      add: [],
      remove: [{ text: "Old.", reason: "r" }],
      replace: [],
    });
  });

  it("refuses a merged proposal over the cap through checkBriefProposal", () => {
    const merged = mergeBriefProposals(open, {
      add: ["a", "b", "c", "d"].map((text) => ({ text, quote: "placeholder" })),
    });
    expect(
      checkBriefProposal(merged, {
        userMessages: ["its a placeholder, 3 inch, placeholder"],
        briefLines: ["It uses 2 inch rollers."],
        dismissed: new Set(),
      }),
    ).toMatch(/at most 5/i);
  });
});
