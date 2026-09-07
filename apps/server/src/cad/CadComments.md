# CAD comments

Agent findings belong to the originating chat and the exact downloaded CAD they describe. Missing screws are an example; deciding whether an empty hole requires a screw is outside this feature.

## Agent workflow

1. `cad_comments_list` reads existing findings, including reviewed findings, and returns the creation catalog version. Walk `nextCursor` before deciding an issue is new. A changed creation catalog invalidates a cursor; review changes do not advance that catalog.
2. Capture the private view with the existing `cad_capture` tool. `cad_comment_locate` takes that capture ID and explicit intended occurrence IDs with original 1280 ? 960 image coordinates (top-left origin, continuous pixels). The nearest visible surface wins. An intervening part returns `occurrence-mismatch`; the ray never searches through it for the intended part.
3. `cad_comment_inspect` returns numbered candidate markers from a different camera angle. Yellow candidates are visible; red candidates cannot be confirmed. The agent must verify the actual surface/depth, then cite the inspection and explain its confirmation when publishing. A same-part inner wall can still be the wrong location. If the exact location is uncertain, publish a whole-part target with `preciseLocationLimitation`.
4. `cad_comments_publish` takes `expectedCatalogVersion` and up to 20 complete items. New items contain `publicationKey`, `inspectedSnapshotId`, title, body, and 1?20 targets. Point targets cite candidate/inspection IDs; whole-part targets cite explicit occurrence IDs. Every target must pass before its comment appears. Valid items and their receipts commit together; invalid items return individual errors.
5. Reuse a prior finding with `kind: "reuse"`, a new publication key, the inspected snapshot, and `reuseCommentId`. Reuse preserves review state. Material new evidence can be a new finding linked with `correction` or `follow-up`, an existing same-chat/root comment ID, and an explanation. Neither link closes the original.

Retry identical publications with the same keys. Receipts are checked before transient candidate handles, so a lost response can be retried after activation ends. Changing a successful key's payload conflicts. Responses include the current review state, placement, original event sequence, and current creation catalog version.

## Persistence and ownership

`cadComments.ts` defines the schemas. The comments service validates ownership, candidates, images, geometry, and model equivalence. Internal orchestration commands serialize publication and review; the existing CAD projection transaction writes comments and receipts. Only the user-facing review RPC can resolve, dismiss, or reopen a published finding, using an expected review version and idempotent command ID. Published text and targets are immutable.

Points are stored in source-part local meters after inverting the full captured occurrence transform, including explosion. `comment-model-v1` compares canonical source microversion/configuration, dependencies, nodes/transforms, part references, and asset hashes. Import UUIDs and timestamps do not determine equivalence. The same verified model can reuse comments after reimport.

Each activation pins inspected geometry through validation and an uninterruptible publication dispatch. The production snapshot store rechecks live SQL comment references under its deletion mutex. Thus an obsolete deletion list cannot remove a snapshot after its first comment commits. Deletion does not hold that mutex while waiting on the command queue; the pure decider never accesses the store. Current/rollback retention continues independently. Reviewed findings retain their CAD too; deleted chats/projects release their ownership.

Successful precise comments retain numbered PNG evidence and reconstruction metadata under `cad/comment-evidence/<hashed-chat-id>`. Activation cleanup removes unused inspection artifacts after checking durable references. Deleted-chat/project events remove that chat's evidence directory. Candidates expire with their activation; restart requires a new locate/inspect sequence unless replaying a successful publication receipt.

## Viewer behavior

The Comments button immediately counts open findings on the displayed model, with one count per comment. The themed floating card stays closed until opened. It offers a compact title list, one expanded finding, named locations, Previous/Next controls, and shared review state across a finding's targets. Numbered point markers remain visible while the card is closed. Whole-part findings have an explicit location limitation.

Selecting a finding focuses its first location outside the card with surrounding geometry. Selecting the location again refocuses. The viewer tries alternate angles before temporarily hiding blockers and reveals a hidden/isolated target. Manual orbit input cancels animation. Review visibility is layered over the user's visibility settings; closing restores visibility while keeping the camera. Self-occlusion is reported instead of hiding the target itself.

Historical selection opens retained original geometry without rolling back project CAD. Back to current restores the saved current camera, framing, visibility, isolation, and explosion when its model still matches. If CAD changed during review, it opens the newest current view and explains the change.

## Verification

- Real SQLite/orchestration tests cover partial publication, receipt replay, review conflicts, cross-chat rejection, required inspection, publication against an older inspected snapshot, evidence retention, and stale deletion requests.
- Geometry tests exercise source/GLTF/explosion transforms, repeated instances, opening misses, nearest occluders, image bounds, orthographic visibility, and model identity.
- Provider transport tests enumerate the eight CAD tools and preserve native image delivery.
- Local browser checks cover selecting locations, resolving/reopening, history/back, and reload. A real imported spacer verifies rim picking and the numbered alternate view.

These checks establish mechanics, not autonomous accuracy in deciding whether a screw is missing. Inspection relies on the agent's explicit visual confirmation and conservative whole-part fallback.
