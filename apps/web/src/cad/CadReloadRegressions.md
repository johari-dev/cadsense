# Navigation and comment performance investigation

## September 12: testing origin and premature cache fallback

The testing link was changed from HTTPS port 10000 to 8443. Both served the same
optimized build, but browser storage is origin-scoped, so the new port could not
reuse the previous CAD range cache. The canonical testing link is again port 10000.

A normal-graphics Edge reproduction also downloaded ten geometry ranges on page
reload despite persisted geometry. The 250 ms cache-read deadline abandoned valid
slow reads. The deadline is now two seconds, retaining bounded fallback for stalled
storage. A 500 ms storage-read test failed before the change and passes afterward;
a second test verifies unavailable storage still falls back at the deadline.

Built preview `index-B2O3BElh.js` was checked against the complete 1,362-component
Epsilon robot through port 10000. With all 22 optimized ranges persisted, reload
took 7.266 seconds and requested only the manifest and transfer index: zero geometry
downloads. Panel close/reopen took 314 ms with zero CAD requests. A fresh-browser
load took 17.005 seconds. These are individual local automated samples, not remote
device guarantees. Software-rendered probes were excluded from timing comparisons.

Validation: the 145-test CAD suite passed before adding the additional stalled-read
case; all 12 cache tests then passed, along with web typechecking, targeted lint,
formatting, and production build. Browser evidence and the runnable probe are in
the sibling `t3code-0fd752c2/.cadsense/comment-ux-verification/` debug directory as
`cad-cache-probe.mjs`, `cad-cache-probe.json`, and `cad-cache-verified.png`.

Reported triggers: switching threads/projects, reopening CAD, and dismissing or resolving comments.

## Reproduced and fixed

- `CadCommentsCard` scheduled another animation frame unconditionally. A stationary comment marker performed 60 projections in 60 simulated animation ticks. Each real projection can raycast the assembly to determine occlusion. The overlay now subscribes to renderer frames and coalesces updates after layout. The same reproduction performs one projection, updates again after graphics change, and stops projecting resolved markers. Unmount cancels pending work and unsubscribes.
- `CadScene` tied canvas attachment and scene loading to the entire server ticket object. A warm scene was released and reacquired when its ticket first arrived, when an equivalent ticket object arrived, and when the lease was replaced. The reproduction counted four attachments and loads. Canvas ownership now follows the mounted scene; download work follows the lease's values. Once loaded, the scene does not reload or restart its camera transition for a lease change. Cold requests still wait for authorization, abort obsolete requests, and ignore late responses.
- A cached manifest was treated as if its scene were already displayed. During a warm historical/current switch, comment targeting could briefly inspect the prior scene and report `Location unavailable`. The renderer now exposes the manifest for its active scene separately from its cached manifests. Readiness remains pending until that scene is active; an already displayed warm scene is applied directly without another load or camera transition.
- The visible renderer expired after 60 seconds detached, forcing the 216 MB full robot through another roughly 37-second load after an ordinary review break. Desktop retention is now five minutes, still bounded to one renderer, three scenes, and the aggregate scene budget. The existing constrained-memory policy continues to release immediately.

## PoC comparison

The reference checkout matches `AadiJo/cadsense` commit `e65516921a5843c3c5413f71fd585fa846c45bd7`. Its [viewer frame](https://github.com/AadiJo/cadsense/blob/e65516921a5843c3c5413f71fd585fa846c45bd7/apps/web/src/cadViewerFrame.ts) caches parsed Three.js models by file URL and size. Its [panel](https://github.com/AadiJo/cadsense/blob/e65516921a5843c3c5413f71fd585fa846c45bd7/apps/web/src/components/CadPanel.tsx) distinguishes model loading from view commands. The useful comparison here is stable model identity across presentation changes; these fixes preserve the current immutable-snapshot model rather than porting the older loader.

## Verification and limits

From `apps/web`, run `node ../../node_modules/vite-plus/bin/vp test run --project unit src/cad` (127 passing tests). The focused reproductions were run failing before their fixes. Web typechecking passes. Targeted lint has three existing warnings on unchanged lines.

Existing tests also cover warm project round trips, memory/count eviction, cancelled scene construction, and serialized view persistence. Subsequent controlled-browser testing with the full robot is documented in [CadBrowserRegressionTesting.md](./CadBrowserRegressionTesting.md).

The original fixes above retained completed scenes only in memory. The subsequent cold-load investigation below addresses unfinished loads and persistent browser storage.

## Cold panel reopen reproduction

In the remote browser, closing the panel at 6% (12.6 / 202.1 MB) and reopening it one second later reset the indicator to Preparing CAD. The trace contains 57 bundle requests instead of 49, including eight repeated range starts. The transfer increased from 118,876,974 encoded bytes on a clean load to 131,556,029 bytes. No socket closure accompanied this reproduction.

The server already held the imported CAD. The repeated transfer was between the local backend and the browser, not a new Onshape import. An unfinished load was owned by the mounted panel: detaching aborted its fetches, cancelled renderer construction, and released its scene capability. The follow-up moves those responsibilities to the bounded resident viewer, so reopening can subscribe to existing progress and completion.

The resident viewer now owns one selected-snapshot load session, its abort controller, and an exact extra mount of the server scene capability. Detaching suspends canvas interaction but leaves that session running. A same-snapshot reopen receives the latest progress immediately and applies the newest thread view when loading finishes. A different snapshot aborts the old HTTP work, releases its ticket, and invalidates the renderer generation so a late parse cannot replace the newly selected scene. Failure state is also replayed, and a refreshed ticket is retained as a fallback without interrupting a still-valid request.

All snapshot profiles now use the server's manifest-ordered bundle ranges. Validated ranges are cached in bounded IndexedDB storage under server, environment, snapshot, and byte-range identity. Cache reads verify the manifest's deduplicated total byte length; corrupt or unavailable storage falls back to the live authorized request. Four read/write lanes match the bundle reader's 16 MB prefetch bound, while a 512 MB LRU disk budget prevents unbounded persistence. Renderer-memory hits keep their existing no-request path.
