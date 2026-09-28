import { CadReviewScope } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  CAD_REVIEW_INSTRUCTIONS,
  CAD_REVIEW_LEARNINGS_HEADING,
  cadReviewInstructions,
} from "./CadReviewInstructions.ts";

const scopes = Schema.decodeUnknownSync(Schema.Array(CadReviewScope));

describe("cadReviewInstructions", () => {
  it("is the shared guidance alone without scopes or learnings", () => {
    expect(cadReviewInstructions({ learnings: [] })).toBe(CAD_REVIEW_INSTRUCTIONS);
    expect(cadReviewInstructions({ learnings: [], scopes: [] })).toBe(CAD_REVIEW_INSTRUCTIONS);
    expect(CAD_REVIEW_INSTRUCTIONS).not.toContain("Review scopes");
  });

  it("lists ignored scopes on one line and quotes each instruction scope", () => {
    const text = cadReviewInstructions({
      learnings: [],
      scopes: scopes([
        { match: { material: "*purchased*" }, ignore: true },
        {
          match: { path: "Drivetrain <1>/**" },
          instructions: "The gearbox ratio is fixed by the team;\n do not question it.",
        },
        { match: { name: "*bolt*" }, ignore: true },
        {
          match: { name: "Bracket*", material: "*aluminum*" },
          instructions: "Check wall thickness.",
        },
      ]),
    });
    expect(text.startsWith(CAD_REVIEW_INSTRUCTIONS)).toBe(true);
    const lines = text.slice(CAD_REVIEW_INSTRUCTIONS.length).trim().split("\n");
    expect(lines).toEqual([
      "Review scopes from this project's cadsense.json:",
      "Ignored components (do not capture, inspect, or comment on them; cad_hierarchy marks them ignored and publication rejects targets there): material *purchased*; name *bolt*.",
      "Components matching path Drivetrain <1>/**: The gearbox ratio is fixed by the team; do not question it.",
      "Components matching name Bracket*, material *aluminum*: Check wall thickness.",
    ]);
  });

  it("omits the ignored line when every scope is an instruction", () => {
    const text = cadReviewInstructions({
      learnings: [],
      scopes: scopes([{ match: { name: "Gear*" }, instructions: "Gears are purchased." }]),
    });
    expect(text).not.toContain("Ignored components");
    expect(text).toContain("Components matching name Gear*: Gears are purchased.");
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

  it("puts review scopes before learnings", () => {
    const text = cadReviewInstructions({
      learnings: [{ text: "Vent holes are intentional." }],
      scopes: scopes([{ match: { name: "*bolt*" }, ignore: true }]),
    });
    expect(text.slice(CAD_REVIEW_INSTRUCTIONS.length).trim().split("\n\n")).toEqual([
      "Review scopes from this project's cadsense.json:\nIgnored components (do not capture, inspect, or comment on them; cad_hierarchy marks them ignored and publication rejects targets there): name *bolt*.",
      `${CAD_REVIEW_LEARNINGS_HEADING}\n- Vent holes are intentional.`,
    ]);
  });
});
