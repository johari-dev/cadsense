# Check CAD review defaults

Use this check when changing review guidance in `../provider/CadReviewInstructions.ts`.
The guidance reaches Codex through developer instructions and Claude through the
system prompt. `CadProviderTools.ts` adds a shared reminder before publication. Transport tests check delivery, not review quality.

## Run the review

1. Sync an assembly into an isolated Cadsense project using the app-testing skill.
2. Start fresh chats with GPT-5.6-Terra and medium reasoning. Use the prompts below
   without adding instructions about writing style, comment placement, or checklists.
3. Wait for each review to finish. Open every comment and inspect its marked location.
4. Record the model, source revision, prompts, run IDs, comment text, and failures.
   Keep results with the PR so a successful tool call cannot substitute for reading the comments.

Use these two prompts on a telescoping arm with a pivot and printed motor supports:

> Can you review my telescoping arm and pivot? It's based on 2910's 2023 arm, without the end effector. I moved the motors and added printed supports with wire passages. Do those look okay? I'm planning to lighten the pivot plates and need a wire route for the moving motor. Most fasteners aren't added yet; the MaxSpline collars are in the CAD.

> I've been working on this telescope arm with pivot only, excluding the end effector, based on the 2023 Jack in the Bot 2910. I'm planning a lightening pattern on the pivot side plates and adding the rest of the fasteners to check for small interferences. I changed the motor placement, so I added printed supports with hollow wiring paths. The elevator motor moves a little and I want a neat wire path instead of wires hanging loose. The MaxSpline collars should all be in the CAD. Any feedback to improve my design?

## Assess each comment

Require all of the following for each published comment:

- The marker identifies the feature discussed. A whole-part target has a reason that fits the issue.
- The comment addresses one issue and explains a practical change, check, or specific question at that spot.
- The title and body make sense without reading the chat. Usually one or two plain sentences suffice.
- Claims follow from the inspection. A verified marker alone does not prove rubbing, interference, weakness, or a safe cutout size.
- Known unfinished work appears only when it creates a specific additional concern. An empty hole alone does not establish a missing screw.
- The comment adds information instead of repeating another finding or giving advice that could go anywhere on the assembly.

Record failures even when most comments pass. No fixed comment count is required.
Also check that the final reply briefly summarizes the review instead of repeating
all comments. These runs are a behavioral spot check, not proof of engineering
correctness or consistent behavior across models and assemblies.

## Recorded check: September 20, 2026

GPT-5.6-Terra, medium reasoning, fresh chats, using the two prompts above without
follow-up coaching. The downloaded Assembly 1 has 577 components. Its Onshape
microversion is `00bc99fc702d682d31e0d064`, document
`e5fd6dd412a8653a52ad3252`, element `e46921a75b1bb6cff79888e0`.

| Prompt               | Run ID                                 | Result                                                                              |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Short review request | `d769fcac-1e16-47a0-931f-8c9db370e361` | One two-sentence comment, point on the printed support; three-sentence final reply. |
| Student update       | `0cc60d3d-165a-448c-a5ef-8040e28b8a8f` | One two-sentence comment, point on the printed support; three-sentence final reply. |

The comments, transcribed without editing:

> **Add a protected wire exit here**
>
> This motor cradle has no visible path or clamp for the moving motor cable. Add a rounded pass-through or side exit and a tie-down point, then leave a loose loop between this support and the stationary frame so the pivot can travel without pulling the connector.

> **Add a wire clamp at this support**
>
> The printed support gives the elevator-motor wiring a covered route, but the model does not show a clamp that takes load off the motor lead. Add a tie-down or removable cover near this channel and leave a short service loop so the motor's small motion does not pull on the connector.

Result: partial improvement, not a full quality pass. Neither run used report
labels or raised the known missing bolts as a finding. Both comments were opened
in the viewer: the markers lie on the blue support face, but do not identify an
exact wire exit. The first comment's claim that no path is visible needs further
inspection given the user's stated wire passage. The second retains the unexplained
term "service loop". Both summaries still contain some technical phrasing.

An earlier tool-description-only version produced a long report and dense plate
advice. Moving the guidance into session instructions and explicitly limiting
unsupported strength claims improved brevity, but did not eliminate these misses.
Claude delivery is covered by code checks; this behavioral check ran only Terra.
