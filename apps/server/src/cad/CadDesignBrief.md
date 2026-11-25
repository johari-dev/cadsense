# Project design brief

A design brief is a markdown file the designer keeps in the project workspace. Agents read it at the start of every CAD review as the user's stated intent and constraints, so the chat prompt no longer has to restate what the mechanism does, what it must survive, and which parts are off limits. Without a brief, the review guidance in `../provider/CadReviewInstructions.ts` still applies; the model just has to infer intent from the prompt and the geometry.

## Location

`DESIGN.md` at the workspace root. `designBrief` in `cadsense.json` overrides that with another workspace-relative path:

```json
{
  "$schema": "https://cadsense.app/schema/cadsense.json",
  "designBrief": "docs/arm-brief.md"
}
```

Paths outside the workspace and absolute paths are ignored with a server warning. The reader removes `<!-- ... -->` comments, then trims; a missing file, or one empty after that, means no brief. Content is cut at 16 KiB with a truncation note, so keep the brief short and put long analyses elsewhere in the workspace where the agent can read them on request.

## Template and entry points

New briefs start from `CADSENSE_DESIGN_BRIEF_TEMPLATE` in `packages/contracts/src/cadsenseProjectFile.ts`: three questions inside one HTML comment (what the mechanism is, what moves, what is missing or a stand-in). Students write their answers below the comment, so only their sentences reach the agent and an untouched template counts as no brief. [CadDesignBriefSpec.md](CadDesignBriefSpec.md) explains why the template asks nothing else.

The web app opens the brief from project settings, from a card on the new-thread screen while the brief is unanswered, and from a "Brief" button in the CAD panel's title row once it has an answer (`apps/web/src/components/designBrief/`). `designBriefState` in `@cadsense/shared/designBrief` decides missing, template, or filled with the same comment stripping as the reader. Creating the brief is a create-only write, so the server never replaces an existing brief with the template.

## How it reaches the agent

`CadDesignBrief.ts` reads the file. `cadReviewInstructions` appends it after the shared review guidance and before any review learnings, under "Project design brief (path), written by the designer", and the guidance tells the agent to prefer the brief over inference and to ask when the brief and the model disagree.

Both providers read the brief when a chat's session starts: Claude through the system prompt, and Codex through the thread's `developerInstructions` on `thread/start` and `thread/resume`. Before each new turn they read it again with the learnings. When either changed, `cadGuidanceUpdate` builds a block with the changed parts, and the adapter sends it as its own text item before the user's text, once. A Claude steer into a running turn carries no block; the change waits for the next turn. The spec's "Freshness" section has the details. `cad_context` reports `designBrief: { path, bytes }` for the file as it is on disk, or `null`, so a user can confirm the brief was picked up.

## Verification

- `CadDesignBrief.test.ts` covers the default path, the configured path, missing and empty files, the untouched and partly filled template, paths escaping the workspace, truncation, malformed `cadsense.json`, and an unreadable brief.
- `../provider/CadReviewInstructions.test.ts` covers instruction assembly with and without a brief, and the update block for changed guidance. The Codex transport tests in `../provider/Layers/CodexCadTools.test.ts` check the brief reaches developer instructions only when CAD tools are registered, and that an edit reaches the next `turn/start` once.
- `CadViewing.test.ts` checks the Claude system prompt append, the `cad_context` report from a real workspace, and that an edit reaches the next new Claude turn but not a steer.
- [The review evaluation](CadReviewEvaluation.md) describes running the behavioral check with and without a brief.
