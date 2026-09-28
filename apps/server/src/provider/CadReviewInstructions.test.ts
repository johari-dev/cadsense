import { describe, expect, it } from "vite-plus/test";
import {
  CAD_REVIEW_INSTRUCTIONS,
  CAD_REVIEW_LEARNINGS_HEADING,
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
  it("is the shared guidance alone without a design brief, ignored components, or learnings", () => {
    expect(cadReviewInstructions({ learnings: [] })).toBe(CAD_REVIEW_INSTRUCTIONS);
    expect(cadReviewInstructions({ learnings: [], designBrief: null, ignored: [] })).toBe(
      CAD_REVIEW_INSTRUCTIONS,
    );
    expect(CAD_REVIEW_INSTRUCTIONS).not.toContain("Ignored components");
  });

  it("lists every ignored entry on one line", () => {
    const text = cadReviewInstructions({
      learnings: [],
      ignored: [{ material: "*purchased*" }, { name: "Bracket*", path: "Drivetrain <1>/**" }],
    });
    expect(text.slice(CAD_REVIEW_INSTRUCTIONS.length).trim().split("\n")).toEqual([
      "Ignored components from this project's cadsense.json (do not capture, inspect, or comment on them; cad_hierarchy marks them ignored and publication rejects targets there): material *purchased*; path Drivetrain <1>/**, name Bracket*.",
    ]);
  });

  it("appends one line per learning in order after the shared guidance", () => {
    const text = cadReviewInstructions({
      learnings: [
        { text: "Vent holes are intentional." },
        { text: "The motor is a placeholder;\n  do not review its mount." },
      ],
    });
    expect(text.startsWith(`${CAD_REVIEW_INSTRUCTIONS}\n\n${CAD_REVIEW_LEARNINGS_HEADING}\n`)).toBe(
      true,
    );
    expect(text.split("\n").slice(-2)).toEqual([
      "- Vent holes are intentional.",
      "- The motor is a placeholder; do not review its mount.",
    ]);
  });

  it("orders the design brief, then ignored components, then learnings", () => {
    const text = cadReviewInstructions({
      learnings: [{ text: "Vent holes are intentional." }],
      designBrief: brief,
      ignored: [{ name: "*bolt*" }],
    });
    expect(text.slice(CAD_REVIEW_INSTRUCTIONS.length).trim().split("\n\n")).toEqual([
      "Project design brief (DESIGN.md), written by the designer. Treat it as the user's stated intent and constraints:",
      "# Arm",
      "The elevator motor rides on the moving stage by design.",
      "Ignored components from this project's cadsense.json (do not capture, inspect, or comment on them; cad_hierarchy marks them ignored and publication rejects targets there): name *bolt*.",
      `${CAD_REVIEW_LEARNINGS_HEADING}\n- Vent holes are intentional.`,
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
});

describe("design brief in Codex developer instructions", () => {
  it("gives Codex the brief only with CAD tools", () => {
    const withBrief = buildCodexDeveloperInstructions("default", runtime, true, true, {
      learnings: [],
      designBrief: brief,
    });
    expect(withBrief).toContain("## Local CAD tools");
    expect(withBrief).toContain("Project design brief (DESIGN.md)");
    expect(withBrief).toContain(brief.content);

    const withoutBrief = buildCodexDeveloperInstructions("default", runtime, true, true, {
      learnings: [],
      designBrief: null,
    });
    expect(withoutBrief).toContain(CAD_REVIEW_INSTRUCTIONS);
    expect(withoutBrief).not.toContain("Project design brief");

    const withoutCad = buildCodexDeveloperInstructions("default", runtime, true, false, {
      learnings: [],
      designBrief: brief,
    });
    expect(withoutCad).not.toContain("Project design brief");
    expect(withoutCad).not.toContain(brief.content);
  });
});
