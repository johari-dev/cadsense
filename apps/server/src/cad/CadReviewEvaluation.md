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

## Assess the review

Judge decision quality before brevity:

- Does the review understand the mechanism's intended motion and stated design constraints? A motor moving with its stage must not become a loose-mount finding without evidence.
- Does it identify the most consequential supported concern and explain its effect on operation? Accept an explicit evidence gap when no main concern is established.
- Does it investigate relevant manufacturing, assembly, wiring, operation, and repair steps on the actual model? A generic lifecycle checklist is not evidence of inspection.
- Do recommendations explain their purpose and relevant tradeoffs, such as support weight or access lost through tighter packaging?
- Does it use the team's stated targets rather than inventing requirements such as five-minute repairs or a mandatory material?
- Does the student have a clearer next design decision after reading the review?

Keep mechanism-wide concerns in the summary and specific obstructions or features
in CAD comments. A review need not cover every lifecycle stage or publish a fixed
number of findings to pass.

## Assess each comment

Require all of the following for each published comment:

- The marker identifies the feature discussed. A whole-part target has a reason that fits the issue.
- The comment addresses one issue and explains a practical change, check, or specific question at that spot.
- The title and body make sense without reading the chat. Usually one or two plain sentences suffice.
- Claims follow from the inspection. A verified marker alone does not prove rubbing, interference, weakness, or a safe cutout size.
- Known unfinished work appears when it blocks a specific decision, with the dependency explained. An empty hole alone does not establish a missing screw.
- The comment adds information instead of repeating another finding or giving advice that could go anywhere on the assembly.

Record failures even when most comments pass. No fixed comment count is required.
Also check that the final reply briefly explains the main concern and next decisions instead of repeating
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

## Matched evaluation before the review-process update

These results compare baseline `9479482ee` with `ef30dc417`, before the added
intent, lifecycle, and tradeoff guidance. Both versions used the same snapshot
and GPT-5.6-Terra with medium reasoning in fresh chats. An initial six-run batch
hit renderer timeouts and was excluded. The four replacement runs below had no
renderer-failure reports. These are individual runs, not statistical estimates.

Motor prompt:

> I moved the motors and added these printed supports with hollow paths for the wires. Do the supports look okay? The elevator motor moves a little, and I'm not sure how to route its wires without them hanging loose. Can you review that part of my arm? Most bolts aren't in the CAD yet.

Pivot prompt:

> I want to add a lightening pattern to the pivot side plates on this arm. Can you review them and help me figure out what to change? I haven't added most of the bolts yet, but the MaxSpline collars are in the CAD.

| Case  | Baseline run                           | Updated run                            | Final reply words | CAD comments |
| ----- | -------------------------------------- | -------------------------------------- | ----------------- | ------------ |
| Motor | `61b747fc-179f-45a6-b8fe-59fb2eb84e0a` | `51a52e0e-4bfa-40e1-b89f-c74ff371e1be` | 216 → 75          | 0 → 2        |
| Pivot | `995e64d3-e09c-4b4e-9d93-ecfe06efc544` | `3de0bf39-cde5-4a7c-b3d8-6292d9e57e0f` | 249 → 66          | 0 → 2        |

The updated motor comment was more local:

> **Clamp the wire at this channel exit**
>
> The hollow path protects the wire, but it does not retain it at the motor. Add a small zip-tie or clip near the motor exit and leave a short service loop so elevator motion bends a controlled length of cable.

However, it also published this unsupported interpretation:

> **Finish the elevator motor mount**
>
> The elevator motor can move at this support. Add the intended mounting bolts and any washers or retainer for this pattern, then check that the motor has no play before running it.

The baseline had speculated that absent bolts "may allow the small movement you
noticed." The updated version turned that assumption into a definite finding.
Neither established that the described motion was mounting play rather than
intended stage travel. This fails intent and evidence checks despite its brevity.

The baseline pivot reply recommended "0.5 in ligaments" as a conservative starting
point without a load calculation. The updated comment instead asked for arm load,
plate thickness, and the final fastener layout before setting a band width. Yet
another updated comment still instructed: "Put the main weight-saving window in
this open triangular field, with large inside radii." It still prescribed a cutout
region without analysis. Both updated cases also retained technical phrasing.

## Lessons incorporated from team reviews

The September 16 team reviews led with consequential concerns such as structural
stability, accessibility, and compactness. Their useful questions followed real
work: reaching a motor, replacing a mechanism, retaining shafts, routing wires,
and manufacturing parts without adding play. The side-roller discussion first
established that compactness explained the layout choice.

The review defaults now use that process: understand intent, investigate actual
use and maintenance, identify the main supported concern, and explain changes
with their tradeoffs. Missing fasteners or wires can block a design decision even
when the student already plans to add them. Team-specific repair times and
material preferences remain context, not universal rules.

The matched results above motivated this revision; they do not validate it. Rerun
the motor and pivot prompts to assess whether the new guidance prevents the
motion-to-looseness inference and unsupported cutout recommendations. Also test
repair-access and compactness cases on suitable CAD before claiming those review
skills work reliably.
