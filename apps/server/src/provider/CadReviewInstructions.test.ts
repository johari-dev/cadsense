import { CadReviewScope } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CAD_REVIEW_INSTRUCTIONS, cadReviewInstructions } from "./CadReviewInstructions.ts";

const scopes = Schema.decodeUnknownSync(Schema.Array(CadReviewScope));

describe("cadReviewInstructions", () => {
  it("is the shared guidance alone when a project has no scopes", () => {
    expect(cadReviewInstructions([])).toBe(CAD_REVIEW_INSTRUCTIONS);
    expect(CAD_REVIEW_INSTRUCTIONS).not.toContain("Review scopes");
  });

  it("lists ignored scopes on one line and quotes each instruction scope", () => {
    const text = cadReviewInstructions(
      scopes([
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
    );
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
    const text = cadReviewInstructions(
      scopes([{ match: { name: "Gear*" }, instructions: "Gears are purchased." }]),
    );
    expect(text).not.toContain("Ignored components");
    expect(text).toContain("Components matching name Gear*: Gears are purchased.");
  });
});
