# CAD inspection views

`cad_update_view` supports temporary highlighting, ghosting, and section planes in each agent's private, revision-aware view. A capture records these settings with its resolved camera. Captured views and user views retain them after restart. Older saved views omit the fields and render normally.

| Operation          | Behavior                                                                                      | Clear               |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------- |
| `highlight`        | Replaces up to 256 selected occurrence IDs with amber-highlighted subtrees.                   | `occurrenceIds: []` |
| `ghost`            | Replaces up to 256 selected occurrence IDs with translucent subtrees. `opacity` is 0.05–0.95. | `occurrenceIds: []` |
| `section`          | Replaces up to six clipping planes.                                                           | `planes: []`        |
| `reset-inspection` | Clears all three effects. Camera, visibility, isolation, and explosion remain unchanged.      |                     |

The component tree exposes Highlight and Ghost actions. The camera toolbar exposes an axis-aligned section editor and Reset inspection. The tool accepts arbitrary plane orientations and multiple planes.

A plane retains points satisfying `dot(normal, point) + constant >= 0`. The normal has unit length, with tolerance below `1e-6`. The constant is in meters, between `-1e9` and `1e9`. Every plane must retain a point for it to appear. Plane coordinates refer to displayed world space after explosion. For example, normal `[1,0,0]` and constant `-0.02` retain `x >= 0.02` meters.

Sections clip rendered mesh surfaces without caps. They do not create CAD faces, modify authoritative geometry, or provide section measurements. Camera fitting continues to use complete visible-occurrence bounds. The outline overlay is disabled during ghosting and sections because its normal override cannot represent those effects faithfully.

Picking and alternate comment inspection apply the same clipping planes as captures. Clipped surfaces cannot become candidate locations or pass alternate-view visibility verification. A transparent front hit returns `transparent-hit` instead of guessing which layer was intended. This includes source materials with transparency, alpha testing, or transmission. Hide the front component or clear ghosting before locating a precise comment. Transparent geometry conservatively blocks verification of targets behind it.

Geometry, source materials, and textures remain immutable and shared. A scene owns its highlight and ghost material variants. Occurrences with the same source material and inspection style share one variant within that scene. Camera changes reuse variants; reset, style changes, and scene eviction dispose them without disposing source resources.

When a view adopts a new snapshot of the same root, highlight and ghost selections lose obsolete occurrence IDs. World planes remain fixed. Selecting another root clears inspection settings.

## Verification

State tests cover bounded input, atomic rejection, old JSON compatibility, snapshot rebasing, reset, durable capture correspondence, and persistence after service recreation. Geometry and renderer tests cover occurrence and renderer isolation, material reuse and disposal, clipped front-hit filtering, transparent-hit rejection, and alternate inspection of clipped targets.

Local Chromium verification used the actual renderer, component tree, and camera toolbar with an isolated generated-box fixture. Highlight, Ghost, and Apply section each changed the captured PNG pixels. Both resets reproduced the original pixel digest exactly. No page errors occurred. Screenshots and capture digests are retained under the worktree's `.cadsense/inspection-test` directory. Controlled-preview routing to the local server failed, so this verification used local headless Chromium with SwiftShader. This was not an Electron or production CAD import test.
