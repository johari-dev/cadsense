import { assert, it } from "@effect/vitest";

import { CAD_REVIEW_INSTRUCTIONS, buildCadReviewInstructions } from "./CadReviewInstructions.ts";
import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

const brief = {
  path: "DESIGN.md",
  bytes: 64,
  content: "# Arm\n\nThe elevator motor rides on the moving stage by design.",
};
const runtime = { model: "gpt-5.6-terra", reasoningEffort: "medium" };

it("appends the design brief after the shared review guidance", () => {
  assert.equal(buildCadReviewInstructions(null), CAD_REVIEW_INSTRUCTIONS);
  const withBrief = buildCadReviewInstructions(brief);
  assert.ok(withBrief.startsWith(CAD_REVIEW_INSTRUCTIONS));
  assert.include(
    withBrief,
    "Project design brief (DESIGN.md), written by the designer. Treat it as the user's stated intent and constraints:\n\n# Arm",
  );
  assert.include(CAD_REVIEW_INSTRUCTIONS, "prefer it over inference");
});

it("gives Codex the brief only with CAD tools", () => {
  const withBrief = buildCodexDeveloperInstructions("default", runtime, true, true, brief);
  assert.include(withBrief, "## Local CAD tools");
  assert.include(withBrief, "Project design brief (DESIGN.md)");
  assert.include(withBrief, brief.content);

  const withoutBrief = buildCodexDeveloperInstructions("default", runtime, true, true, null);
  assert.include(withoutBrief, CAD_REVIEW_INSTRUCTIONS);
  assert.notInclude(withoutBrief, "Project design brief");

  const withoutCad = buildCodexDeveloperInstructions("default", runtime, true, false, brief);
  assert.notInclude(withoutCad, "Project design brief");
  assert.notInclude(withoutCad, brief.content);
});
