import { describe, expect, it } from "vite-plus/test";
import {
  CAD_REVIEW_INSTRUCTIONS,
  CAD_REVIEW_LEARNINGS_HEADING,
  cadReviewInstructions,
} from "./CadReviewInstructions.ts";

describe("cadReviewInstructions", () => {
  it("is the shared guidance alone without learnings", () => {
    expect(cadReviewInstructions([])).toBe(CAD_REVIEW_INSTRUCTIONS);
  });
  it("appends one line per learning in order after the shared guidance", () => {
    const text = cadReviewInstructions([
      { text: "Vent holes are intentional." },
      { text: "The motor is a placeholder;\n  do not review its mount." },
    ]);
    expect(text.startsWith(`${CAD_REVIEW_INSTRUCTIONS}\n\n${CAD_REVIEW_LEARNINGS_HEADING}\n`)).toBe(
      true,
    );
    expect(text.split("\n").slice(-2)).toEqual([
      "- Vent holes are intentional.",
      "- The motor is a placeholder; do not review its mount.",
    ]);
  });
});
