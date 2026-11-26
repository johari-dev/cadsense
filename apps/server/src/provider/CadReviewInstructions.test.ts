import { describe, expect, it } from "vite-plus/test";
import { CAD_TOOL_INPUTS } from "@cadsense/contracts";
import { CAD_PANEL_TOOLS } from "./CadProviderTools.ts";
import {
  CAD_BRIEF_PROPOSAL_RULE,
  CAD_REVIEW_INSTRUCTIONS,
  CAD_REVIEW_LEARNINGS_HEADING,
  cadGuidanceUpdate,
  cadReviewInstructions,
} from "./CadReviewInstructions.ts";
import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

const brief = {
  path: "DESIGN.md",
  bytes: 64,
  content: "# Arm\n\nThe elevator motor rides on the moving stage by design.",
};
const runtime = { model: "gpt-5.6-terra", reasoningEffort: "medium" };

describe("cadReviewInstructions", () => {
  const session = `${CAD_REVIEW_INSTRUCTIONS}\n\n${CAD_BRIEF_PROPOSAL_RULE}`;
  it("is the shared guidance and the app's proposal rule without learnings or a design brief", () => {
    expect(cadReviewInstructions({ learnings: [] })).toBe(session);
    expect(cadReviewInstructions({ learnings: [], designBrief: null })).toBe(session);
  });
  // `cadsense mcp` sends CAD_REVIEW_INSTRUCTIONS to reviews outside the app and hides the panel
  // tools from them. The shared text must never tell those agents to call a tool they lack.
  it("names no tool in the shared guidance that reviews outside the app cannot call", () => {
    const named = [...new Set(CAD_REVIEW_INSTRUCTIONS.match(/\bcad_[a-z_]+\b/g) ?? [])];
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((tool) => !Object.hasOwn(CAD_TOOL_INPUTS, tool))).toEqual([]);
    expect(named.filter((tool) => CAD_PANEL_TOOLS.has(tool))).toEqual([]);
    expect(CAD_BRIEF_PROPOSAL_RULE).toContain("cad_brief_propose");
  });
  it("appends one line per learning in order after the shared guidance", () => {
    const text = cadReviewInstructions({
      learnings: [
        { text: "Vent holes are intentional." },
        { text: "The motor is a placeholder;\n  do not review its mount." },
      ],
    });
    expect(text.startsWith(`${session}\n\n${CAD_REVIEW_LEARNINGS_HEADING}\n`)).toBe(true);
    expect(text.split("\n").slice(-2)).toEqual([
      "- Vent holes are intentional.",
      "- The motor is a placeholder; do not review its mount.",
    ]);
  });
  it("appends the design brief after the shared review guidance", () => {
    const withBrief = cadReviewInstructions({ learnings: [], designBrief: brief });
    expect(withBrief.startsWith(CAD_REVIEW_INSTRUCTIONS)).toBe(true);
    expect(withBrief).toContain(
      "Project design brief (DESIGN.md), written by the designer. Treat it as the user's stated intent and constraints:\n\n# Arm",
    );
    expect(CAD_REVIEW_INSTRUCTIONS).toContain("prefer it over inference");
  });
  it("puts the design brief before the learnings", () => {
    const text = cadReviewInstructions({
      learnings: [{ text: "Vent holes are intentional." }],
      designBrief: brief,
    });
    const briefAt = text.indexOf("Project design brief (DESIGN.md)");
    const learningsAt = text.indexOf(CAD_REVIEW_LEARNINGS_HEADING);
    expect(briefAt).toBeGreaterThan(CAD_REVIEW_INSTRUCTIONS.length - 1);
    expect(learningsAt).toBeGreaterThan(briefAt);
    expect(text.endsWith("- Vent holes are intentional.")).toBe(true);
  });
});

describe("design brief in Codex developer instructions", () => {
  it("gives Codex the brief only with CAD tools", () => {
    const withBrief = buildCodexDeveloperInstructions("default", runtime, true, true, [], brief);
    expect(withBrief).toContain("## Local CAD tools");
    expect(withBrief).toContain("Project design brief (DESIGN.md)");
    expect(withBrief).toContain(brief.content);

    const withoutBrief = buildCodexDeveloperInstructions("default", runtime, true, true, [], null);
    expect(withoutBrief).toContain(CAD_REVIEW_INSTRUCTIONS);
    expect(withoutBrief).not.toContain("Project design brief");

    const withoutCad = buildCodexDeveloperInstructions("default", runtime, true, false, [], brief);
    expect(withoutCad).not.toContain("Project design brief");
    expect(withoutCad).not.toContain(brief.content);
  });
});

// The update block a running chat gets when the brief or learnings change after its session
// started. Ways it can fail: it fires with nothing changed, it resends a source that did not
// change, it drops the new content, or a removal reads as "nothing changed".
describe("cadGuidanceUpdate", () => {
  const learning = { text: "Vent holes are intentional." };
  const delivered = { learnings: [learning], designBrief: brief };

  it("is null when nothing changed, including whitespace inside a learning", () => {
    expect(cadGuidanceUpdate(delivered, delivered)).toBeNull();
    expect(
      cadGuidanceUpdate(delivered, {
        learnings: [{ text: "Vent holes  are\nintentional. " }],
        designBrief: { ...brief, bytes: 99 },
      }),
    ).toBeNull();
  });

  it("sends an edited brief whole and leaves the unchanged learnings out", () => {
    const edited = { ...brief, content: "The 84T belt is a stand-in." };
    const update = cadGuidanceUpdate(delivered, { learnings: [learning], designBrief: edited });
    expect(update).toContain("CAD guidance changed");
    expect(update).toContain("Project design brief (DESIGN.md)");
    expect(update).toContain("The 84T belt is a stand-in.");
    expect(update).not.toContain(brief.content);
    expect(update).not.toContain(CAD_REVIEW_LEARNINGS_HEADING);
  });

  it("sends the current learnings and leaves the unchanged brief out", () => {
    const added = { text: "The belly pan is a placeholder." };
    const update = cadGuidanceUpdate(delivered, {
      learnings: [learning, added],
      designBrief: brief,
    });
    expect(update).toContain(CAD_REVIEW_LEARNINGS_HEADING);
    expect(update).toContain("- Vent holes are intentional.");
    expect(update).toContain("- The belly pan is a placeholder.");
    expect(update).not.toContain(brief.content);
  });

  it("says so when the brief or every learning is removed", () => {
    const update = cadGuidanceUpdate(delivered, { learnings: [], designBrief: null });
    expect(update).toContain("no longer has a design brief");
    expect(update).toContain("no review learnings");
    expect(update).not.toContain(brief.content);
  });
});
