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

Paths outside the workspace and absolute paths are ignored with a server warning. A missing or empty file means no brief. Content is trimmed and cut at 16 KiB with a truncation note, so keep the brief short and put long analyses elsewhere in the workspace where the agent can read them on request.

## Suggested structure

Contents are free-form. These headings cover what reviews most often get wrong without them:

- **Intended motion.** What moves, what it is attached to, and what moves with it. "The elevator motor rides on the moving stage" stops a motor that travels from being flagged as a loose mount.
- **Load cases and materials.** Expected loads, impacts, and the material or print settings of each structural part, so strength claims have something to check against.
- **Rulebook or size and weight limits.** Frame perimeter, extension, height, and weight targets, with the margin the team wants to keep.
- **Repair and assembly targets.** Which parts must be swappable at an event, how fast, and which tools are available.
- **Known unfinished work.** Fasteners, wiring, or lightening not yet modeled, so the review treats them as dependencies rather than findings.
- **Purchased parts.** Off-the-shelf parts that should not be redesigned, and any that have already been modified.

## How it reaches the agent

`CadDesignBrief.ts` reads the file. `cadReviewInstructions` appends it after the shared review guidance and before any review learnings, under "Project design brief (path), written by the designer", and the guidance tells the agent to prefer the brief over inference and to ask when the brief and the model disagree.

Codex reads the brief on every turn, so an edit applies to the next message. Claude reads it when its session starts, because the SDK fixes the system prompt for the life of the process; edits reach a Claude chat after the session restarts. `cad_context` reports `designBrief: { path, bytes }` for the file as it is on disk, or `null`, so a user can confirm the brief was picked up.

## Verification

- `CadDesignBrief.test.ts` covers the default path, the configured path, missing and empty files, paths escaping the workspace, truncation, malformed `cadsense.json`, and an unreadable brief.
- `../provider/CadReviewInstructions.test.ts` covers instruction assembly with and without a brief, and the Codex transport test in `../provider/Layers/CodexCadTools.test.ts` checks the brief reaches developer instructions on the wire only when CAD tools are registered.
- `CadViewing.test.ts` checks the Claude system prompt append and the `cad_context` report from a real workspace.
- [The review evaluation](CadReviewEvaluation.md) describes running the behavioral check with and without a brief.
