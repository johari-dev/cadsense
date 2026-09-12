# Full robot browser regression testing

## September 12: unfinished loads and persistent browser cache

This follow-up supersedes earlier limitations about panel cancellation, individual historical-asset requests, and missing persistent browser storage.

- Before the fix, closing the current robot panel at 6% and reopening it reset progress and issued 57 bundle requests, with eight repeated range starts. After the fix, three mid-load toggles completed with exactly 49 ranges, no repeated ranges, and progress continuing through 14% and 24%.
- The current model's measured CAD transfer fell from 118,876,974 to 83,043,160 encoded bytes, preserving the same 203,497,863 decoded bytes including the manifest. The observed network interval fell from 36.24 to 24.95 seconds. The fixed cold page was ready at 34.31 seconds after navigation; this includes startup and is not a claim of instant first-device loading.
- Closing the original full-detail historical robot at 10% allowed its load to finish while hidden. Its transfer used 78 bundle ranges plus one manifest, with zero repeated ranges and 104,077,784 encoded bytes. Reopening made no additional request.
- IndexedDB held all 127 ranges for both models, totaling 525,026,728 bytes within the 512 MiB budget.
- Reloading final build `index-CSDMmU6u.js` fetched only the current manifest (190,262 encoded bytes) and **zero geometry ranges**. The current robot was ready at 8.20 seconds after page navigation. Selecting the historical battery comment also made zero geometry requests; its disk load, parsing, and framing took about 8.79 seconds.
- Five further historical/current round trips and Resolve → Reopen → Dismiss → Reopen added no CAD requests. The battery comment was restored to open. The final page recorded no page errors, WebGL context losses, or client socket closures. An earlier cold-test page recorded two startup socket closures, without any repeated range request during panel toggling.

The preview reads existing local snapshots; these tests made no new Onshape import. Persistent browser storage is bounded and best-effort. Browser storage clearing, eviction, a new device, or a new snapshot can still require a transfer. Warm parsed scenes remain bounded separately by the existing renderer policy. This is browser verification, not an Electron restart or a direct timing comparison against the PoC with an identical source file.

Validation: 127 CAD tests, 12 relevant server/HTTP tests, web and server typechecks, targeted lint, formatting, and production build passed. The previously passing 272 client-runtime tests cover the unchanged connection fix. Evidence is retained in `.scratch/cad-browser-regressions/cold-toggle-before.json`, `cold-toggle-after.json`, `history-background-load.json`, and `persistent-cache-final-build.json`.

Tested September 11, 2026 (local time), using the built renderer and isolated `.cadsense/comments-test/userdata` backend. Browser access used the existing HTTPS proxy to local port 14224 because the controlled browser could not reach the Vite listener. No Onshape import or provider execution was needed.

## Models

| Model                                          | Nodes | Geometry assets | Manifest asset bytes |
| ---------------------------------------------- | ----: | --------------: | -------------------: |
| Current Epsilon robot, coarse 3MF              | 1,362 |             467 |          216,484,800 |
| Historical Epsilon robot, original medium glTF | 1,362 |             467 |          322,976,716 |
| Kraken motor, cross-project control            |     6 |               3 |            6,389,832 |

The historical robot contains the battery-location comment used for review testing. It is the original full-detail assembly, not the small smoke fixture.

## New defect reproduced and fixed

A second application-active notification during a pending connection health check interrupted that check and closed an otherwise healthy WebSocket. This can lose RPC replies: dismissing/reopening the comment changed the persisted state but displayed a failure notice. Captured review requests were followed by client socket closures with code 1000, without their replies, at approximately 477 ms and 1,274 ms.

Minimal browser reproduction: dispatch two `visibilitychange` events 20 ms apart while the document is visible. Before the fix, this closed the connection. The controlled browser also emits foreground events while interacting, making the problem frequent in this test environment.

`packages/client-runtime/src/connection/supervisor.ts` now keeps the pending health check when further foreground notifications arrive. Failed and timed-out checks still reconnect. The regression test failed before the change (two connections and one release instead of one connection and zero releases). Three tests cover coalescing, failure recovery, and the unchanged timeout deadline.

After rebuilding, ten overlapping foreground events caused zero socket closures. Resolve → reopen → dismiss → reopen completed with explicit success notices, correct marker removal/restoration, the same canvas, and zero additional geometry requests. Further review transitions with foreground events also retained the socket and geometry. The battery comment was returned to open.

## Browser coverage

- Six short CAD panel close/reopen cycles retained the original canvas and added no CAD HTTP responses.
- Ten same-project thread switches retained the canvas and geometry. The selected front camera preset returned with its thread.
- Ten robot/motor project switches after loading both models added no CAD HTTP responses. Both scenes reused the same viewer canvas.
- Five current/historical robot round trips after both were loaded added no requests and retained the canvas. A separate sixth round trip sampled the transient location notice described below.
- Four seconds idle with the full-detail robot and one marker produced zero marker attribute mutations and zero long tasks in the observed interval.
- All seven camera presets, four exploded-view toggles, component-tree opening, part/assembly isolation actions, and panel maximization/restoration caused no geometry download or WebGL context loss. These actions are coverage checks, not frame-rate benchmarks.
- No captured page errors, unhandled rejections, or WebGL context loss occurred during these checks.

Initial current-robot loading took approximately 37 seconds over the remote proxy, with 50 CAD HTTP responses. Original-detail history loading required 468 responses (manifest plus assets); observed cold loads varied approximately 30–55 seconds. These network-dependent observations are not a local-machine performance benchmark. Warm interaction timings included deliberate settling waits and should not be treated as measured application latency.

## Additional findings

These were findings from the initial test pass. The follow-up fixes and verification below supersede the first two items.

- Rapidly selecting a historical comment can briefly display `Location unavailable` even though its location is valid. In a 100 ms sampling run it was present at 100 ms and gone at 200 ms; the marker then remained visible. This is a reproducible presentation issue, not a lasting lost location or geometry reload. Not changed in this patch.
- In the narrow CAD panel, the top-right comments card covers part of the historical `Back to current` button. Closing comments exposes it. Not changed in this patch.
- Intermittent `Syncing messages...` notices were seen during rapid navigation, including after the socket fix. No geometry reload accompanied them; this test does not establish their underlying cause.

## Verification and limitations

The CAD suite passes 109 tests and the client-runtime suite passes 272 tests, including all three supervisor cases. Web and client-runtime typechecking pass. Targeted supervisor lint and `git diff --check` pass. The web production build succeeds with the existing chunk-size/source-map warnings.

Browser instrumentation and captured checks are retained under the debug directory `.scratch/cad-browser-regressions/`. They record CAD response counts, canvas identity, review notices, long tasks, and client socket closure counts, without authorization headers. The instrumentation is not shipped in application code.

Viewport resizing through the browser host timed out, so layout verification used the actual narrow panel and the application's maximize/restore controls. This was browser-renderer testing, not an Electron process restart, low-memory-device test, or sustained frame-rate profile. No persistent browser asset cache was added.

The browser automation host disconnected after the CAD panel was closed for the final expiry check. Repeated status calls then reported no available host. Consequently, reopening after the 60-second viewer expiry and the final page-reload camera-persistence check were not completed. The previously measured short reopen cycles passed. The existing code still explicitly expires the detached viewer after 60 seconds and retains at most three scenes within its memory budget; those policies remain potential reasons for cold loading outside the warm paths exercised here.

## Follow-up implementation and browser verification

At the user's request, Sol independently reviewed and implemented lifecycle fixes. Sol ran through the native subagent interface because Claude Code does not recognize its model alias. Opus ran through `claude -p --model opus` after authentication was refreshed, completing 59 turns/tool steps before the account session limit stopped it. Opus produced no final review report or implementation; its review must be treated as incomplete. Sol also reviewed the primary agent's comment changes and found no correctness issues.

Implemented:

- Publish a scene as ready only when its manifest belongs to the renderer's active snapshot. Cached historical manifests no longer trigger premature comment focus.
- Reattach an already displayed warm scene without calling the loader or restarting its camera transition; restore saved comment framing on this path.
- Retain the detached desktop viewer for five minutes instead of one. One renderer, the three-scene/aggregate memory limits, and immediate cleanup on constrained devices remain in effect.
- Guard review submissions synchronously per comment and disable review controls until the reply arrives, preventing conflicting resolve/dismiss requests before React renders the pending state. Controls recover after both successful and failed replies.
- Position the expanded historical comments card below revision navigation and preserve space for the Back to current button.
- Hide comment markers until the displayed scene is ready, including during cold historical loads, so markers cannot be projected against the previous revision's geometry.

Every behavioral fix has a regression test that failed before its change. Layout was checked in the real browser. Final automated checks: 113 CAD tests, 272 client-runtime tests, both package typechecks, and `git diff --check` pass. Targeted lint has only the three previously recorded warnings on unchanged lines.

The browser host became available again, allowing the previously incomplete checks to proceed:

- **Old policy reproduction:** after 69.6 seconds detached, reopening replaced the canvas and fetched another 50 CAD responses (approximately 202 MB of bundle payload), taking roughly 38 seconds to finish loading.
- **New policy verification:** after 83.5 seconds detached, reopening reused the original canvas and made zero additional CAD requests; the panel returned ready without a download.
- **Revision focus:** five rapid current/historical round trips reused assets and produced zero `Location unavailable` notices, monitored continuously with a DOM observer.
- **Review race:** immediate Resolve then Dismiss clicks left both controls disabled while pending and completed one resolution successfully; reopening restored the comment to open, with no geometry download.
- **Layout:** measured historical Back to current and expanded card rectangles did not overlap. The button was directly clickable with the card open.
- **Interrupted loading:** switching to the motor project partway through a cold robot download and then returning completed successfully on one canvas, without a page error or WebGL context loss. Discarded partial downloads must restart; this patch does not add resumable transfers.
- **Page reload:** the saved Front camera preset returned after rebuilding and reloading the page. Browser restarts still cold-load geometry because no persistent browser asset cache exists.

The follow-up page recorded one client socket closure about 1.2 seconds into startup, before the navigation stress checks. There were no additional closures during the recorded warm navigation/review tests. Do not interpret these tests as proof that every connection-recovery edge case is fixed.

Debug evidence: `.scratch/cad-browser-regressions/old-ttl-browser-checks.json` and `fixed-ux-browser-checks.json`. The production build and isolated backend are retained for manual inspection.

Final build `index-CZPMZ_eV.js` was loaded and checked again: markers were absent during cold historical loading, then one visible battery marker appeared when the full-detail assembly was ready. The observed load interval had no premature-marker or unavailable-location samples, page errors, or WebGL context loss. Final-build evidence is in `final-build-browser-checks.json`. Two client socket closures occurred during this page's startup; the marker/readiness fixes do not claim to address all startup connection behavior. The browser is left on the full-detail robot with its open battery comment for inspection.
