# Local FeatureScript

A local compiler and runtime for Onshape FeatureScript, so a feature can be previewed without
calling the Onshape API. It runs Onshape's real Standard Library (`std/`, MIT, PTC) on our own
interpreter, with the native `@builtins` implemented on OpenCascade (`replicad-opencascadejs`).

Onshape stays the reference. Local results are checked against values recorded from real Onshape;
they are expected to drift in places (different geometry kernel), and the tests make that visible.

## Previewing a feature

From the repo root:

```sh
pnpm fs:preview path/to/feature.fs \
  --param 'count=8' --param 'holeDiameter=6 * millimeter' \
  --param 'face=qContainsPoint(qCreatedBy(makeId("Base"), EntityType.FACE), vector(50, 30, 10) * millimeter)' \
  --base part.step
```

It runs the file's first feature (or `--feature name`) on top of `--base` (a STEP file; its bodies are
created by `makeId("Base")`) and any `--before file.fs:feature` steps, then prints the feature's
inputs, its status, and the resulting solids. When a feature fails it prints the cause and the line.
Parameters are FeatureScript expressions; unset inputs take their defaults. It writes `iso.png`,
`top.png`, `front.png`, `right.png` (faces the feature created in amber), `result.glb` and
`report.json` to `--out` (default `.cadsense/fs-preview/<file name>`), and exits 1 if a feature fails.

An agent can run this, read the PNGs and the summary, edit the script, and run it again.

### In the app

Agents in a CAD chat get the same thing as the `cad_featurescript_preview` tool (in-app Claude and
Codex; not the standalone `cadsense mcp` server, whose review workspaces an outside agent can't
write to). Input is `{path, feature?, parameters?, before?, base?, view?}`, with `path`, `before[].path`
and `base` relative to the project workspace. It returns a status (`OK`, `INFO`, `WARNING`, `ERROR`,
or `INVALID` when the script doesn't load, or `STOPPED` on a timeout or crash), the same summary as
the CLI, the first failure with its line in the user's script (a failure inside std is reported at
the user's line that called into it), the volume change and the number of faces the feature made,
the solids, and the chosen view as a PNG. Artifacts for each run go to
`<state>/attachments/featurescript-previews/<time>-<id>/`, and the newest 50 are kept. Each call also
shows in the chat as a card (`cad.featurescript.previewed` activity) with the status, the failing
line, the views (copied into the thread's attachments) and the change; its links open the script in
the file panel with the agent's inputs, base and earlier features (`before`).

People get the same loop in the file panel. A `.fs` file there has a Code/Preview toggle like
markdown. Preview shows the model after the feature, with the faces it made in amber and a
Before/After switch, under an Onshape-style dialog of the feature's inputs (read from its
precondition; inputs its `if`s hide are hidden). Editing an input, picking in the model, or
saving the file runs it again; a run takes about a tenth of a second. A click gives a face input
the nearest face the preview draws (`qClosestTo` over faces that aren't sketch regions or
construction), so faces an earlier feature made count too. A point input (a vertex or mate
connector filter) gets a mate connector at the click, Z out of the face and X std's
`perpendicularVector` of Z, created before the features run by `makeId("Picked") + "<id>"`. Like a
mate connector someone places in Onshape, it's a body: `qEverything(EntityType.BODY)` sees it. List inputs (`definition.waypoints is array` with a loop over its
items) get items to add, reorder and remove; an item's unset inputs take their defaults. A failure
keeps the last good model on screen, greyed out, under the cause, a "Show line" link and an "Ask
the agent to fix it" button, or "for a workaround" when the runtime can't run a builtin. The base is
the workspace's only STEP file until someone picks another. The panel calls
`featurescript.preview` with the editor's text; its before/after GLBs are `fspanel-*.bin`
attachments, and the newest 40 are kept. Meshes are indexed (each face's vertices once, normals
smoothed within a face), and the asset route gzips them for clients that accept it.

The server runs previews in one worker thread (`apps/server/src/featurescript/`), one at a time.
A worker loads std and OpenCascade and runs a small warm-up preview as soon as it starts (about a
second), and stops after 10 idle minutes. Shapes are never freed, so once a worker's WASM memory
passes 1.5 GB (a preview adds a few MB) it's replaced, and the replacement starts right away so it's
warm by the next preview. A preview that takes over
2 minutes is stopped by terminating the worker. Each preview reloads the user's modules, so edits
take effect, while std stays loaded. Bundled builds ship the worker as `dist/featurescript-worker.mjs`
and std as `dist/featurescript-std/`, and keep `replicad-opencascadejs` external, since it loads
its WASM from beside itself.

The base is a STEP file the user exports from Onshape for now. Syncing it from the Part Studio
(milestone M5) needs the Onshape API.

## Layout

- `std/`: vendored Standard Library, re-pinned with `scripts/vendor-std.ts`. `std/VERSION.json`
  records the version, mirror commit and a sha256 per file.
- `src/syntax/`: source positions, lexer, AST, parser, diagnostics, and an S-expression printer for
  tree-shape tests.
- `src/runtime/`: values, module loading and name resolution, the tree-walking interpreter, and the
  modeling context (variables, feature status, rollback).
- `src/builtins/`: native builtins. `index.ts` lists every builtin std calls as implemented or
  unsupported, and the type check fails if one is missing.
- `src/spec/`: reads a feature's inputs from its precondition, the way Onshape builds the dialog.
- `src/geometry/`: the OpenCascade layer. `Model.ts` is the topology registry (transient ids that
  survive operations through OpenCascade's history), `Sketch.ts` sketches and regions, `Query.ts`
  query evaluation, `Tessellate.ts` and `Glb.ts` preview meshes.
- `src/Runtime.ts`: loads std and runs features in a fresh context, optionally on a STEP base.
- `src/preview/`: runs a preview and writes its artifacts (`Preview.ts`), the feature dialog's rows
  (`Inputs.ts`), and a small software renderer for PNGs (`Render.ts`). `scripts/preview.ts` is the
  CLI.
- `corpus/<case>/`: end-to-end cases. `case.json` lists the features to run, their parameters as
  FeatureScript expressions, and the expected statuses, volumes and topology counts (and where the
  expectations come from). `test/corpus.e2e.test.ts` runs them and writes
  `.cadsense/fs-corpus/<case>/result.png` (the last feature's faces in amber), `result.glb` and
  `report.json`.
- `test/broken/`: files with syntax errors; each lists the exact diagnostics it must produce.
- `spikes/`: throwaway measurements from milestone M0. Results are below.

## Language notes

Sources: [Lexical conventions](https://cad.onshape.com/FsDoc/tokens.html),
[Syntax and semantics](https://cad.onshape.com/FsDoc/syntax.html),
[Top-level constructs](https://cad.onshape.com/FsDoc/top-level.html), and std itself.

- Semicolons are never optional. Strings use `'` or `"`, with escapes `\b \t \n \f \r \uXXXX` and
  the matching quote. Numbers are decimal floats plus `inf`.
- Keywords: `annotation enum export function import operator precondition predicate returns type`,
  `typecheck typeconvert as is new break const continue for in return var while if else false inf`,
  `true undefined catch throw try`, reserved `assert case default do switch`. `switch (x) { k : v }` is
  used by std as a map-lookup expression.
- Assignment operators: `= += -= *= /= ^= %= ||= &&= ??= ~=`. No `++`/`--`.
- Map literal keys: a bare identifier is a string (`{ a : 1 }` is `{ "a" : 1 }`); string and number
  literals are themselves; `(expr)` and other expressions (`Enum.VALUE`) are evaluated. Maps (and so
  `switch` maps) take a trailing comma, which std never uses but community scripts do; arrays don't.
- Imports by Onshape element id (`img::import(path : "87ad57ff25961bfc9686bd3e", ...)`, or
  `document/version/element`) bring in icons, images and other documents' code. They can't be
  fetched locally, so they load as unavailable modules: annotations that use them (icons) are
  skipped, and a name or type that may have come from one fails where it's used, naming the element.
- Any other import path is a file in the workspace, relative to the importing file:
  `import(path : "wire-run.fs", version : "")` in `wiring/robot.fs` loads `wiring/wire-run.fs`. The
  version is ignored. Onshape has no such paths; a script pasted into Onshape imports by element id.
- `x->f(a)` is `f(x, a)`; `f` must be an identifier. `x[]` reads a box. `x?.y`, `x?[i]` and `a ?? b`
  are undefined-safe.
- Lambdas: `function (params) returns T precondition ... { body }`, or `x => expr`,
  `(a is T, b) returns T => expr`, where `expr` may be a `{ ... }` block. After `=>`, a `{` that opens
  `"key" :`, `number :`, `(` or `}` is a map literal, otherwise a block.
- Precedence used here (the docs don't publish a table), lowest first: `?:` (right), `??`, `||`, `&&`,
  `== !=`, `< > <= >= is as`, `+ - ~`, `* / %`, unary `- !`, `^` (right, binds tighter than unary
  minus, so `-x^2` is `-(x^2)`), postfix (call, `.`, `[]`, `->`, `?.`, `?[`). Cases that matter are
  on the conformance list below.

## Failure modes

Written before the tests. Each one names the test that guards it.

### Lexer and parser

1. **A valid construct is rejected.** Std uses syntax we didn't anticipate. Guard: every vendored std
   file parses with zero diagnostics (`std.parse.test.ts`).
2. **Invalid code is accepted.** A missing `;`, an unbalanced brace, or a stray token parses anyway.
   Guard: `test/broken/*.fs`, each with an expected `line:column` and code.
3. **Wrong tree, no error.** Precedence or associativity mistakes (`-x^2`, `a ~ b + c`, `x is T && y`,
   nested `?:`, `a ?? b || c`, `x->f(y)[0]`, `a + b as T`) produce a different program that still parses.
   Guard: tree-shape tests that print the AST as S-expressions; values confirmed later by Onshape
   conformance recordings.
4. **Ambiguity resolved the wrong way.** `{` as block vs map (statement start, after `=>`, after
   `annotation {...}`), `(a) => e` vs a parenthesized expression, `x[]` vs `x[i]`, `function` declaration
   vs lambda, bare-identifier map keys vs evaluated keys. Guard: tree-shape tests.
5. **Wrong positions.** Off-by-one lines or columns, CRLF, tabs, and non-ASCII text in comments and
   strings move every diagnostic. Guard: broken fixtures with CRLF and non-ASCII content.
6. **Hangs or crashes on bad input.** Unterminated strings or comments and early EOF must end in a
   diagnostic, never an infinite loop or exception. Guard: broken fixtures; the parser must always
   consume a token or stop.
7. **Error cascades.** One mistake reports hundreds of errors. Guard: broken fixtures assert the
   first diagnostic exactly and that the total stays small.
8. **Slow parsing.** Pathological lookahead makes 7 MB of std slow to parse. Guard: the std parse
   test records the time and fails above a budget.
9. **Literal mistakes.** `1e-5`, `.5`, `3e9`, escapes, `\u` sequences, single-quoted strings.
   Guard: tree-shape tests.
10. **Keywords as names.** `definition.type` and `x.in` are field names; in a map literal only plain
    identifiers are string keys, so `{ true : 1 }` keys on the boolean. Guard: tree-shape tests.

### Interpreter

Semantics come from [Types and type tags](https://cad.onshape.com/FsDoc/type-tags.html),
[Values and types](https://cad.onshape.com/FsDoc/variables.html),
[Exceptions](https://cad.onshape.com/FsDoc/exceptions.html),
[Equality and ordering](https://cad.onshape.com/FsDoc/relational.html), and std itself. The ones that
shape the design:

- Arrays and maps are values: assignment, arguments and returns copy them. Boxes and builtins are
  shared. Storing `undefined` in a map removes the key. Arrays never grow on write.
- A value has one standard type and at most one type tag. `as` replaces the tag (a standard type
  removes it); `is` matches the standard type or the tag. Enum values are strings tagged with the enum.
- Overloads: the most specific satisfying declaration wins, where a tag constraint beats a standard
  type, which beats no constraint. No unique winner is an error. Preconditions run after resolution
  and raise on failure; they don't pick another overload.
- Predicates and preconditions succeed when every executed expression statement is `true`.
- A call to a name holding a function value calls it; otherwise the name means top-level overloads,
  even when a local of that name holds something else. Functions overload across imports, but a
  module's own constant or enum shadows any import of the same name (a custom feature named
  `sphere` runs, not std's `sphere` function).
- Language errors (reading a field of `undefined`, a bad index, no matching overload, a failed
  precondition) are exceptions FeatureScript can catch, and std depends on that: it probes with
  `try silent(...)` all over. Only "not supported locally" builtins and runtime limits bypass `try`,
  so a missing builtin can't be silently swallowed into wrong geometry.
- Maps iterate in a fixed total order: untagged values first, then by type tag, standard type, then
  value. Std relies on enum values sorting by declaration order inside a tag (`isAtVersionOrLater`).
- Lambdas capture the values of enclosing locals when they're created.

Failure modes:

11. **Value aliasing.** A copy shares structure with the original, so `b = a; b[0] = 1` changes `a`, or
    a lambda sees later reassignments. Guard: conformance snippets for every copy path (assignment,
    argument, return, capture, nested container, box sharing).
12. **Wrong overload.** Specificity, arity, tagged-vs-standard matching, or name lookup across imports
    and namespaces picks the wrong declaration. Guard: overload snippets, plus std's own `@example`
    lines, which exercise `toString`, `size`, units and vectors through real std overloads.
13. **Swallowed failures.** An unsupported builtin, an internal bug, or an infinite loop is caught by
    `try` and turns into wrong output. Guard: tests that `try silent` cannot hide unsupported builtins
    or step limits, and that JS exceptions from our code surface as faults.
14. **Uncatchable language errors.** The reverse: a language error escapes `try`. Guard: snippets that
    `try` each language error kind and get `undefined`.
15. **Wrong order.** Map iteration, `keys`, `values` and map equality disagree with the documented order.
    Guard: ordering snippets, including enums and mixed key types.
16. **Lost errors.** A feature that throws reports success, or the error loses its message and location.
    Guard: feature-run tests that check status, `ErrorStringEnum`, custom message and FS stack.
17. **Rollback.** `@abortFeature` leaves a failed feature's variables in the context, or drops the
    error status it should keep. A fault (an unsupported builtin) skips std's rollback and leaves the
    feature's partial geometry behind. Guard: feature-run tests, and a geometry test for faults.
18. **Std drift.** Some std top-level constant needs a builtin or construct we lack. Guard: a test that
    evaluates every top-level constant in std and lists any that fail, with an allowlist that has to
    shrink, never grow silently.
19. **Slow std.** Loading and evaluating std on every run is too slow for previews. Guard: the std test
    records cold load time.
20. **Stale modules.** A warm runtime keeps serving the first source it loaded for a path after the
    file is edited. Guard: preview tests that edit a script between runs. (Found building the server
    worker.)
21. **Split ids.** An operation that splits one body into several (a split, a cut through) gives a
    face cut in two the same id in both pieces, so one piece loses its faces. Guard: the
    `split-block` corpus case checks both pieces' counts. (Found adding `opSplitPart`.)

### To confirm against Onshape (conformance recordings)

- `as` precedence relative to arithmetic (`a + b as T`).
- `??` precedence relative to `||`.
- `^` associativity and unary minus (`-2^2`, `2^3^2`).
- Map key order and number formatting in `toString`.
- How `~` prints tagged values, numbers and nested containers. The docs show
  `ValueWithUnits(27) : { "unit" : ... , "value" : 2 }`; we print the same shape without the internal
  type number, and plain decimal numbers.
- Trailing commas in arrays, argument lists and enums. Std never uses them, so the parser rejects
  them; maps take one, since community scripts that run in Onshape use it.

## M3 status: interpreter

Runs without Onshape. Checked by:

- 70 language cases from the FsDoc pages (copying, tags, overloads, predicates, exceptions, ordering,
  limits).
- 148 `@example` lines from std's own doc comments, run through real std. 143 pass; the other 5 are
  wrong as written (listed with reasons in `stdExamples.test.ts`).
- Every std constant evaluates (above).
- Feature runs through std's `defineFeature`: status, `ErrorStringEnum`, custom messages, rollback of a
  failed feature's variables, and unsupported builtins that `try silent` can't hide.
- The bolt circle's spec matches its source (7 inputs, defaults, bounds, the `Depth` condition), and a
  run with its defaults reaches `@evPlane`, the first geometry call.

Not yet checked against Onshape recordings (the API quota is out). Builtins still unsupported: all
geometry (M4), attributes, sketches, and `@matrixSvd`.

## M4 status: geometry

Std's own features run unmodified on OpenCascade: `fCuboid`, `fCylinder`, `extrude`, `revolve`,
`fillet`, `chamfer`, `shell`, plus the operations they call and `opPattern`, `opTransform`,
`opBoolean`, `opDeleteBodies`. Custom features can also call `opSphere`, `opPlane` and `opPoint`
(construction geometry, left out of preview images), `opThicken` (planar faces both ways, curved
faces one way), `opLoft` (solid or surface, without guides or connections), `opSweep` (the profile
turns with the path), `opSplitPart` (by a plane, a planar face or a sheet), `opFitSpline` (open or
closed, with end and inner derivatives, without second derivatives or a target length) and
`opMateConnector` with `evMateConnector` (a point body carrying its coordinate system; `evVertexPoint`
reads its origin). A transformed or patterned connector's coordinate system moves with it; one whose
owner part moves stays behind, as in Onshape, unless the transform selects it too. (`attachTo` is
ignored: an attached connector should follow later transforms of what it's attached to, and doesn't
yet.) `setProperty`
names bodies (or sets any other property), and the name follows the body through operations and into
the preview's solid summaries. `getProperty` fails: std says it "cannot be called on the current
context inside custom features", and a preview has no other context.

- Sketches: lines, circles, arcs, points. Constraints are accepted but not solved (std's rectangle
  helpers build geometry that already satisfies them). Regions use spike S4's splitter approach.
- Evaluators: `evAxis`, `evLine`, `evBox3d`, `evVolume`, `evArea`, `evLength`, `evDistance` (minimum,
  without edge/face parameters), `evVertexPoint`, `evEdgeTangentLine(s)`, `evFaceTangentPlane(s)`,
  `evPlane`, `evSurfaceDefinition` and `evCurveDefinition` (planes, cylinders, spheres, lines, circles),
  `evApproximateCentroid`, and `evApproximateMassProperties` without a `referenceFrame`.
- Corpus: fourteen cases (bolt circle, turned shaft, filleted block, chamfered block, shelled box,
  boss pattern, evaluators, sphere, construction, lofted frustum, swept tube, thickened plate, split
  block, mass properties). Every volume matches its hand-calculated value and every face/edge/vertex
  count matches Parasolid's conventions. Each case runs in 5-100 ms.

Not supported locally yet (each stops the run with the calling line): draft, hole, helix, loft guides
and connections, sweeps that lock or keep the profile's orientation, sheet metal,
variable/partial/conic fillets, chamfers other than equal offsets, face patterns, evaluators on
B-spline geometry, and sketch constraint solving.

To confirm against Onshape recordings:

- `evPlane` puts the plane origin at the face's centroid; Onshape doesn't document where it goes.
- A sketch makes one wire body and one region sheet body here, and connected sketch lines don't
  share vertices.
- Query results come back in creation order.
- "Through all" extrudes to a generous model extent rather than exactly through.
- Edge tangent parameters are uniform over the curve, which is arc length only for lines and circles.
- `opSplitPart` leaves the original part id on one piece (the lower one in `split-block`).
- `evApproximateMassProperties` products of inertia are `-integral(x y)`, the usual tensor convention.
- `opPlane` without a size makes a 1 m plane, like std's plane feature; `opPoint` points are
  construction entities.
- `qContainsPoint` on solid bodies matches points on their boundary, not inside them.
- `opFitSpline` without `parameters` spaces its points by chord length over [0, 1], so a derivative
  is a length per unit parameter, comparable to the curve's length. Std doesn't say how Onshape spaces
  them; if it differs, end derivatives (a wire's "straightness") will bend differently.
- `getProperty` inside a custom feature raises an error rather than returning undefined.
- A wire or point body (a mate connector) keeps its id through `opTransform`, carried by its edges
  or vertices since it has no faces.
- `qClosestTo` returns every entity within `TOLERANCE.zeroLength` (1e-8 m) of the nearest. The file
  panel uses it for picked faces, because a click lands on the tessellation, which can sit tens of
  microns off a curved face, beyond `qContainsPoint`'s 1e-7 m.

## M0 spike results

Measured 2026-10-01 on WSL2, Node 24.18. Scripts are in `spikes/`.

### S1: OpenCascade WASM in a Node worker (`spikes/occt-worker.ts`)

- `replicad-opencascadejs` 1.1.0: 23 MB WASM. Compiling the module in the parent took 37 ms; a worker
  instantiating that module was ready in 71-80 ms.
- Plate 100 x 60 x 10 mm minus six 5.5 mm holes: boolean 51 ms cold, 12 ms warm; mesh 10-14 ms
  (660 triangles at 0.05 mm deflection); volume 58574.502333 mm³, equal to the analytic value to
  10 significant digits.
- STEP write and read back through the Emscripten file system: 25-81 ms, same face count and volume.
- `worker.terminate()` during a long chain of booleans returned in 6 ms, and a fresh worker ran the
  geometry job normally afterwards.
- Memory: process RSS was ~540 MB with one worker live and ~490 MB after terminating it; a second
  worker did not grow it further. Budget ~0.5 GB for the preview worker.
- The bound `NCollection_IndexedMap_TopoDS_Shape` can't be constructed in this build ("unbound types:
  NCollection_BaseMap"). Shape identity works with `ReplicadShapeHasher.HashCode` buckets plus `IsSame`.
  Shape lists have no iterator binding; copy and pop with `First()`/`RemoveFirst()`.

### S2: Std load

- All 276 files of std 3083 (150k lines, 7 MB) parse and link in ~220 ms, single-threaded, no cache,
  well under the 2 s threshold for adding an AST cache.
- Evaluating all 916 top-level constants takes ~45 ms. 913 evaluate; the other 3 (the tolerance
  definitions) are never evaluated by Onshape either. A preview worker can load std on start.
- Evaluating std's constants found a lexer bug the parser tests missed: `1.e-4` lexed as `(1).e - 4`.

### S3: History naming

- Same cut: OCCT history classified all 12 result faces. 4 plate faces unchanged, 2 plate faces
  modified (top and bottom, now with holes), 6 hole faces `Modified` from the cylinder tools.
  That's what `qCreatedBy` and the amber "changed by this feature" faces need.
- Topology counts differ from Parasolid in a known way: OCCT reports 30 edges and 20 vertices, because
  each cylinder has a seam edge and each circle a vertex. Onshape would report 24 edges and 8 vertices.
  Comparisons and `qOwnedByBody(..., EDGE/VERTEX)` must exclude seam edges and their vertices.

### S4: Sketch regions (`spikes/sketch-regions.ts`)

Splitting a large plane face by all sketch edges (`BRepAlgoAPI_Splitter`) and dropping faces that touch
the outer boundary gives Onshape-style regions in every case tried, 35 ms for all six:

| Case                                       | Regions (mm²)            |
| ------------------------------------------ | ------------------------ |
| Six separate circles r 2.75                | 6 x 23.758               |
| Nested circles r 10, r 4                   | 50.265, 263.894          |
| Overlapping circles r 10, centers 12 apart | 89.459 lens, 224.700 x 2 |
| Rectangle 40 x 20 with circle r 5 inside   | 78.540, 721.460          |
| Rectangle crossed by circle                | 39.270, 39.270, 760.730  |
| Open line only                             | none                     |

### S5: Onshape round trip (`spikes/onshape-roundtrip.ts`)

Blocked. The only Onshape key on this machine answers every metered call with
`402 API limit exceeded`, reads included; `GET /users/sessioninfo` still works. Onshape plans carry an
annual API call quota. The script is ready and writes only to a document it creates, named
"cadsense featurescript fixtures".
