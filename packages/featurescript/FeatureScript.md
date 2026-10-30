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

## Part Studio context

Every context starts like a Part Studio (std's `definePartStudio`): `runFeatures` calls std's own
`addDefaultFeatures(context, meter)` before the base and the features. That creates the Origin (a
construction point body, one vertex) under `makeId("Origin")`, and the Front, Top and Right planes
(construction sheet bodies, 0.15 m squares, std's `PLANE_SIZE_BOUNDS` for meters) under
`makeId("Front")`, `makeId("Top")` and `makeId("Right")`, in that order. Top is XY (normal +Z, x
+X), Front is XZ seen from -Y (normal -Y, x +X), Right is YZ (normal +X, x +Y). `qTopPlane`,
`qOrigin`, `qDefaultBodies` and `qCreatedBy(makeId("Top"), EntityType.FACE)` find them.

They're construction geometry: not solids, not drawn, not counted in a preview's solids, volumes or
created faces, and not picked by the panel (its face query filters construction out). They do count
in `qEverything`: an empty context holds 32 entities (4 bodies, 3 faces, 12 edges, 13 vertices), and
`qBodyType(qEverything(EntityType.BODY), BodyType.SHEET)` includes the three planes, as in Onshape
(std's `mateConnector.fs` filters them out with `qConstructionFilter`). A runtime without a geometry
kernel creates none.

`newSketch` on a face (which realigns the plane with `@alignCanonically`) works for faces facing
like Top, Front or Right (normal +Z, -Y or +X), and sketches in that plane's axes, with the origin
at the projection of the world origin. A face facing any other way stops the run naming its normal;
`newSketchOnPlane` with `evPlane(...)` works on any planar face.

Std is 3095 (277 files, from the mirror's `be9fafcd067d`), re-vendored with
`scripts/vendor-std.ts`; it calls no builtins 3083 didn't. Contexts run at std's current version
(`V3095_LARGE_INTEGER_LITERALS`), like a new Onshape Part Studio, whatever `FeatureScript N;` header
a script declares; import version strings are ignored. A script importing an older std still runs
std 3095's code, so std changes since its version that aren't behind an `isAtVersionOrLater` gate
apply to it (to confirm against Onshape). Scripts declaring 3083 or 1560 run unchanged. A feature
whose definition sets `asVersion` runs at that version, and so do its subfeatures, until it ends or
aborts (never later than its parent's); `isAtVersionOrLater` and `getCurrentVersion` read it, and
`isAtVersionOrLater` honors the `asVersion` argument `sketch.fs` passes.

## Language notes

Sources: [Lexical conventions](https://cad.onshape.com/FsDoc/tokens.html),
[Syntax and semantics](https://cad.onshape.com/FsDoc/syntax.html),
[Top-level constructs](https://cad.onshape.com/FsDoc/top-level.html), and std itself.

- Semicolons are never optional. Strings use `'` or `"`, with escapes `\b \t \n \f \r \uXXXX` and
  the matching quote. Numbers are decimal floats plus `inf`. Integer literals read as the nearest
  IEEE double: `9007199254740993` is `9007199254740992`, and `18446744073709551617` is
  `1.8446744073709552e19`. `V3095_LARGE_INTEGER_LITERALS` is named in std but not used or
  documented anywhere in it.
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

STEP bases keep geometry only. This OpenCascade build (`replicad-opencascadejs` 1.1.0) has
`STEPCAFControl_Writer` and the `XCAFDoc_*` tools but no `STEPCAFControl_Reader`, so part names and
colors in a STEP file aren't read into `NAME` or `APPEARANCE`.

- Sketches: points, lines, circles, arcs, ellipses, elliptical arcs, Bezier curves, conics and fit
  splines, plus std's rectangle, polygon and polyline helpers. `skSolve` solves `skConstraint`'s
  constraints and dimensions (coincident, horizontal, vertical, parallel, perpendicular, tangent,
  equal, concentric, midpoint, mirror, fix, normal, distance, angle, length, radius, diameter, major
  and minor diameter), moving the drawing as little as they allow, so geometry that already
  satisfies them stays put. FIX removes its unknowns; each Gauss-Newton step leaves out equations
  nearly dependent on the others, so redundant constraints change nothing; status OK means every
  equation holds. Where the drawing sits exactly between two solutions (a side, a tangency, an
  angle's sense) the run stops, since Onshape's choice isn't known. Conflicting or unconverged
  sketches fail with `SKETCH_SOLVE_FAILED`, bad references and pairs with std's input errors. Arcs
  run counterclockwise as in Onshape, so a clockwise-drawn arc's `start` is its drawn end. Each
  curve is its own wire body, and each point and circle, arc or ellipse center a point body, all
  created by `sketchId + "wireOp"`; regions are one sheet body created by the sketch.
  `sketchEntityQuery` finds a curve's body and edge by its id, and its ends as
  `"<id>.start"`/`"<id>.end"`. `evOwnerSketchPlane` returns the sketch's plane.
  `skSetInitialGuess` places points, lines, ellipses and elliptical arcs. Regions use spike S4's
  splitter approach.
- Evaluators: `evAxis`, `evLine`, `evBox3d`, `evVolume`, `evArea`, `evLength`, `evDistance`,
  `evVertexPoint`, `evEdgeTangentLine(s)`, `evFaceTangentPlane(s)`, `evFaceTangentPlanesAtEdge`,
  `evPlane` (planar faces and mate connectors' XY planes), `evPlanarEdge(s)`, `evEdgeConvexity`,
  `evCornerType`, `evCollisionDetection`, `evMateConnectorCoordSystem`, `evEdgeCurvature(s)` and
  their derivatives, `evFaceCurvatures`, `evFacePeriodicity`, `evFilletRadius`, `evRaycast`,
  `evMeshPoints`, `evPointsDeviation`, `evSurfaceDefinition` (planes, cylinders, spheres, cones,
  B-splines) and `evCurveDefinition` (lines, circles, B-splines), `evApproximateCentroid`, and `evApproximateMassProperties`
  without a `referenceFrame`. Also `constructPaths`, the linear, circular and curve pattern
  transforms (std's Linear, Circular and Curve pattern features), `matrixSvd`, query variables (std's
  Variable and Query variable features), and operation bookkeeping (`lastOperationId`,
  `lastModifyingOperationId`, `valuesSortedById`, `clampContextVersion`, `getLanguageVersion`).
  Every `QueryType` is handled; the ones listed below stop.
- Edge parameters in [0, 1] measure arc length by default, as std documents, on every curve: the
  speed is integrated adaptively to 1e-12 and inverted by a bracketed Newton search.
  `arcLengthParameterization : false` uses the curve's own parameter, uniformly.
- `evBox3d`, `qFarthestAlong`, `qInFrontOfPlane`, `qIntersectsPlane`: extremes are proven or the run
  stops. Lines, circles, ellipses, spheres, tori closed form; planes, cylinders, cones, extrusions
  via boundary; B-spline, Bezier, hyperbola, parabola edges/faces and surfaces of revolution by
  branch and bound to 1e-11 m; offset and other curves/surfaces stop, as does a trimmed face whose
  search peaks off the face. `tight : false` is an upper bound with no search, stopping only on
  offset/other geometry.
- On-face decisions use a ray-casting classifier in the face's parameter plane; it stops if no ray
  is clean. `evRaycast` edge/corner hits get the face parameter by projection.
- Areas, volumes, centroids (`evPlane`'s origin too): fixed-order only where exact
  (plane/cylinder/cone/sphere/torus faces whose parameter-space boundaries are lines, circles,
  ellipses), adaptive to 1e-12 elsewhere; edge lengths fixed-order only on lines and circles; sizes
  cached per shape.
- `evDistance`: maximum stops; sides may be queries, points, Lines, Planes. Extended sides drop
  bodies; line/circle edges become the whole line/circle; plane/cylinder/sphere/torus faces the
  whole surface; cones only the face's half (Parasolid); unextendable entities count at distance 0,
  else stop. Two lines/planes pair in closed form; an extended cylinder/cone against another
  unbounded side stops. Parameters: faces relative to the parameter box; edges 0..1 (outside when
  extended); Lines the length along; Planes the 2D position; bodies and points 0. Deviation: planar
  faces get real parameters (curve pattern's swept strip is a plane here; zeros would stack
  instances).
- `qCoincidentFilter`: proven exactly or stops; large matching faces take ~2 s (sampled backstop).
- Identity tracking: a body split or merged after tracking starts stops the run, as do
  `startTracking`'s derived entities.
- Query types that stop: sheet metal, composite, mesh, tolerance, `MATE_CONNECTOR`,
  `LAMINAR_DEPENDENCY`, dependency, historical, `qMatching`, and std's four unimplemented types.
- Bezier faces can't arrive locally (STEP converts them to B-splines); a kernel-level test covers
  them.
- Face and body operations: direct edits heal the way Parasolid's local operations do. A box around
  the part is split by the changed faces, their new surfaces and the neighbors' extended surfaces,
  and the cells the change sweeps through are added (a face moved outward, a hole filled) or
  removed. Ids carry through OpenCascade's boolean history; a moved face keeps its id. This covers
  `opDeleteFace` (heal, cap, leave open, `includeFillet`), `opOffsetFace`, `opMoveFace`,
  `opReplaceFace`, `opModifyFillet` and face patterns in `opPattern`. `opExtractSurface` copies
  faces into sheets (with an offset, trimmed only by perpendicular planar neighbors);
  `opCreateOutline` projects tools onto planar targets; `opSplitFace` and `opSplitEdges` imprint
  without cutting the body; `opExtendSheetBody` and `opEdgeChange` move edges of flat one-face
  sheets by a distance; `opDraft` tilts faces about a neutral plane or reference edges square to
  the pull; `opFullRoundFillet` handles one flat center face between parallel planar sides;
  `opExtractWires` and `opFlipOrientation` are complete.
- Shells are accepted only as sharp-join offsets: sampled points on every result face must lie
  exactly the thickness from one source face, none nearer a kept face, with tolerances no looser
  than the input's. OpenCascade's rounded-corner fallback, and features or gaps narrower than two
  walls, stop.
- Every body must pass OpenCascade's full check and keep vertex and edge tolerances within 0.5 mm,
  STEP imports included (the loosest of 45 sample files is 0.069 mm), or the run stops.
  OpenCascade's own STEP files written in meters read back with 5.8 mm tolerances and stop.
- `opTransform` and `opPattern` stop on any matrix OpenCascade can't keep exactly: uneven or
  non-uniform scales (std's `fEllipsoid` among them). The bindings have no general transform.
- Split part and thicken never delete construction planes they use as tools (`splitpart.fs`).
- Every `GeometryState` carries `lineage`: for each entity id, the ids it came from (split, merged,
  generated, pattern-copied), kept across operations and dropped with a rolled-back feature.
- Splitting a whole cylinder's top leaves one more vertex and edge than Parasolid: OpenCascade
  needs a vertex where a periodic face's seam ends.
- Curves and surfaces: `opHole` (std's hole profiles and position references, measured where a
  cylinder of the hole's largest radius meets each target; hole faces and profiles carry std's
  names for `qOpHoleFace`/`qOpHoleProfile`, so std's Hole feature runs), `opHelix` (an interpolated
  B-spline within about 1e-11 of the true helix's radius), B-spline curves and surfaces
  (`opCreateBSplineCurve`/`Surface`, `evaluateSpline`, `approximateSpline`,
  `evApproximateBSplineCurve`/`Surface`, and `evCurveDefinition`/`evSurfaceDefinition` on B-spline
  edges and faces), `opPolyline`, `opExtractWires`, `opIntersectFaces`, `opDropCurve`,
  `opSplineThroughEdges`, `opEditCurve`, `opFillSurface`, `opEnclose` (sheets that meet edge to
  edge) and `opRuledSurface` (aligned with a vector). Std's Helix (circle type), Composite curve,
  Intersection curve, Projected curve (curve to face) and 3D fit spline run.
- `opSweep` is fitted to 0.1 um and starts at the profile. The profile turns with a
  rotation-minimizing frame (lines and arcs keep the analytic frame); keep orientation, lock
  direction, lock faces, scale and twist along straight paths are supported, and profiles with
  holes sweep along closed paths. Sweeps that would fold, stall or run into themselves stop. A
  300-turn spring's volume matches area times path length to 2e-8.
- `opLoft` takes one vertex connection. `opFitSpline` spaces points centripetally, per
  `std/fitSpline.fs`.
- Still stopping in this area: `opOffsetWire`, `opOffsetCurveOnFace`, `opCreateCurvesOnFace`,
  `opMoveCurveBoundary`, `opBoundarySurface`, `opConstrainedSurface`, `opWrap`, `opCreateIsocline`,
  `opSplitByIsocline`; periodic targets, derivatives and `interpolateIndices` in
  `approximateSpline`; non-planar analytic faces in `evApproximateBSplineSurface`; `makeSolid` in
  `opCreateBSplineSurface`; normal projection onto curved faces in `opDropCurve`; G1/G2 fill edges
  with two faces; crossing sheets in `opEnclose`; angled or face-normal ruled surfaces; loft guides,
  several connections and connections along edges; twist along a curved path and
  `extendToFullPath : false` from mid-path; matched hole profiles on slanted faces, holes up to a
  non-planar face, and sheet metal holes; `evSurfaceDefinition` on a B-spline face reversed against
  its surface.
- Corpus: fourteen cases (bolt circle, turned shaft, filleted block, chamfered block, shelled box,
  boss pattern, evaluators, sphere, construction, lofted frustum, swept tube, thickened plate, split
  block, mass properties). Every volume matches its hand-calculated value and every face/edge/vertex
  count matches Parasolid's conventions. Each case runs in 5-100 ms.

Not supported locally yet (each stops the run with the calling line): sheet metal,
variable/partial/conic/asymmetric fillets, chamfers other than equal offsets, healing or offsetting
faces of sheets, `opBodyDraft`, `opFaceBlend`, `opBooleanedPattern`, `opDerip`, offset and other
curve and surface definitions, `evFaceCurvatureDerivatives`, the curve and surface cases listed
above, sketch constraints of other types (projected, offset, patterns, pierce, quadrant,
silhouette, rho, curvature, freeze) or on external references, constraints that would move Bezier
curves, conics or fit splines, ellipse constraints beyond centers, diameters, axis direction and
points on them, distances between circles, and `skSpline`, `skSplineSegment`,
`skInterpolatedSpline`, `skInterpolatedSplineSegment`, `skText`, `skImage`.

To confirm against Onshape recordings:

- `evPlane` puts the plane origin at the face's centroid; Onshape doesn't document where it goes.
- Sketch topology: each curve is its own wire body, coincident ends don't share vertices, a point
  at a curve end still gets its own point body, bodies come wires, then the region sheet, then
  points, and construction `skPoint`s are construction point bodies.
- A failed sketch solve throws `SKETCH_SOLVE_FAILED` and leaves no geometry; Onshape might keep the
  geometry with an error status. A free line given HORIZONTAL moves both ends halfway.
- FIX on a line keeps its infinite line and lets its ends slide; FIX on an arc fixes its center and
  radius. DISTANCE to a circle measures to the curve. Missing dimension values give
  `SKETCH_DIMENSION_DIST_ERROR` (lengths) or `SKETCH_DIMENSION_FAILED` (angles); a NONE constraint
  gives `SKETCH_CONSTRAINT_UNKNOWN`; collinear `skArc` points give `SKETCH_ARC_FAILED`.
- Sketch return values: `skPoint` gives `{ pointId }`, lines and arcs `{ startId, endId }`, circles
  and ellipses `{ centerId }`. Initial guesses other than the elliptical arc's documented format are
  inferred (point [x, y]; line [px, py, dx, dy, t0, t1]). Conic weights use rho / (1 - rho), as
  std's conic classes do.
- Query results come back in creation order.
- "Through all" extrudes to a generous model extent rather than exactly through.
- With `arcLengthParameterization : false`, edge parameters are uniform in OpenCascade's curve
  parameter. Std calls that parameterization "arbitrary", so on curves whose speed varies (splines,
  ellipses) the points may differ from Onshape's. Arc length (the default) is found to 1e-12.
- `opSplitPart` leaves the original part id on one piece (the lower one in `split-block`).
- `opHole`: references use the hole's largest radius; `UP_TO_NEXT` is where the first target is
  exited; `holeDepth` runs from TARGET_START's full entrance to the last profile with a radius;
  `positionReferenceInfo` lists only the references the profiles use; skipped clearance profiles
  step down where the previous profile ends.
- `opHelix`'s `clockwise` (looking along `direction`) is right-handed about it, with the parameter in
  revolutions. `opSweep` twist is right-handed about the path; lock direction is a fixed binormal.
- `opDropCurve` projects along both senses of the direction; `evMaxPathDeviation` takes the larger
  one-sided maximum; `approximateSpline` uses averaged chord-length parameters, least squares and
  clamped ends.
- Draft takes material off on the pull side of the neutral plane (from std's angle manipulator).
- Healing only grows faces that touch the deleted face; deleting a pocket floor fails here, where
  Onshape may extend the walls through to a slot.
- Face edits merge coplanar faces across the whole body, so edges from an earlier split face vanish.
- A moved, offset or replaced face keeps its id; its edges get new ones.
- Error enums: an empty Delete face selection gives `DIRECT_EDIT_DELETE_SELECT_FACES`; deleting
  every face gives `DIRECT_EDIT_DELETE_FACE_ALL_FACES`; a failed extract-surface offset gives
  `DIRECT_EDIT_OFFSET_FACE_FAILED`.
- Split edges parameters run from the edge's oriented start, by length; extract wires joins edge
  ends within 0.1 um; face pattern faces are created by `[...id, instanceName]` and copy the seed's
  attributes.
- `evApproximateMassProperties` products of inertia are `-integral(x y)`, the usual tensor convention.
- `opPlane` without a size makes a 1 m plane, like std's plane feature; `opPoint` points are
  construction entities.
- `qContainsPoint` on bodies matches interior and boundary points (the FeatureScript lead's forum
  answer).
- `qCreatedBy` returns only entities an operation created, not ones it merely modified (std's docs).
- `evCollisionDetection` clash types for solids (from forum reports): overlap and boundary-touching
  containment are `INTERFERE`; strict containment `TOOL_IN_TARGET`/`TARGET_IN_TOOL`; contact without
  overlap `ABUT_NO_CLASS`.
- `EdgeTopology.LAMINAR` is treated as one-sided.
- `getParameterToleranceInfo` returns a tagged `ToleranceInfo` of `NONE`.
- Extended edge parameters past the ends: lines extrapolate (2, -1); circles use the turn after the
  edge's start in its walking direction.
- Extended faces: periodic parameters fall within one turn of the parameter box start.
- Planar faces get real `evDistance` parameters, not the zeros `DistanceResult`'s doc describes
  (curve pattern needs them).
- `evDistance` closest-pair ties start from side0's reference point (two lines/planes) or the
  line's (line and plane); the reference is an edge's midpoint, a face's parametric middle, or a
  Line's or Plane's origin.
- `evBox3d` with `tight : false` is our own upper bound; it may be looser than Onshape's (`tag.fs`'s
  warning reads it).
- Hole up to next with its axis exactly on an edge between two start faces gets two hits at one
  distance.
- Curvature signs follow std's docs; principal curvatures within 1e-7 (relative) are umbilic.
- `lastOperationId` before any operation stops the run (only a fresh `newContext()` has none: a
  Part Studio's default planes are operations); `getFeatureName` fails inside a feature.
- `opFitSpline` without `parameters` spaces its points centripetally over [0, 1], per
  `std/fitSpline.fs`, so a derivative is a length per unit parameter. If Onshape spaces them
  differently, end derivatives (a wire's "straightness") will bend differently.
- `getProperty` inside a custom feature raises an error rather than returning undefined.
- A wire or point body (a mate connector) keeps its id through `opTransform`, carried by its edges
  or vertices since it has no faces.
- `qClosestTo` returns every entity within `TOLERANCE.zeroLength` (1e-8 m) of the nearest. The file
  panel uses it for picked faces, because a click lands on the tessellation, which can sit tens of
  microns off a curved face, beyond `qContainsPoint`'s 1e-7 m.
- The default planes are made with `meter` (0.15 m squares). Onshape passes the document's default
  length unit, so an inch document gets 6 in squares (`PLANE_SIZE_BOUNDS[inch]`). Only the
  displayed size differs; nothing here depends on it except `evArea` of a plane.
- Each default plane has 4 edges and 4 vertices here (the square `opPlane` makes). Std's
  `qTopPlane`/`qFrontPlane`/`qRightPlane` accept only FACE or BODY, and `qOrigin` only VERTEX or
  BODY, so Onshape may expose no plane edges or vertices to `qEverything(EntityType.EDGE)` /
  `(VERTEX)`.
- `qEverything(EntityType.BODY)` includes the Origin and the three planes here.
- `opDeleteBodies` deletes default bodies here (a later feature failing restores them). Onshape may
  refuse.
- The canonical sketch x axis (`alignCanonically`) for normals other than +Z, -Y and +X. Onshape
  doesn't document it; locally those stop the run.
- What `V3095_LARGE_INTEGER_LITERALS` changed in Onshape's parser. Check:
  `println(12345678901234567890);` in a module declaring 3083 and one declaring 3095.
- Whether a script importing an older std runs that std's code in Onshape (locally it runs 3095's,
  with gates at the current version).
- Whether a header newer than Onshape's current version is an error (a forum post says Onshape
  rejects it); locally `FeatureScript 9999;` runs at 3095.

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
  well under the 2 s threshold for adding an AST cache. (Std 3095 has 277 files.)
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
