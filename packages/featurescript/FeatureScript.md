# Local FeatureScript

A local compiler and runtime for Onshape FeatureScript, so a feature can be previewed without
calling the Onshape API. It runs Onshape's real Standard Library (`std/`, MIT, PTC) on our own
interpreter, with the native `@builtins` implemented on OpenCascade (`replicad-opencascadejs`).

Onshape stays the reference. Local results are checked against values recorded from real Onshape;
they are expected to drift in places (different geometry kernel), and the tests make that visible.

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
- `src/Runtime.ts`: loads std and runs a feature in a fresh context.
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
  literals are themselves; `(expr)` and other expressions (`Enum.VALUE`) are evaluated.
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
  even when a local of that name holds something else.
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
    error status it should keep. Guard: feature-run tests.
18. **Std drift.** Some std top-level constant needs a builtin or construct we lack. Guard: a test that
    evaluates every top-level constant in std and lists any that fail, with an allowlist that has to
    shrink, never grow silently.
19. **Slow std.** Loading and evaluating std on every run is too slow for previews. Guard: the std test
    records cold load time.

### To confirm against Onshape (conformance recordings)

- `as` precedence relative to arithmetic (`a + b as T`).
- `??` precedence relative to `||`.
- `^` associativity and unary minus (`-2^2`, `2^3^2`).
- Map key order and number formatting in `toString`.
- How `~` prints tagged values, numbers and nested containers. The docs show
  `ValueWithUnits(27) : { "unit" : ... , "value" : 2 }`; we print the same shape without the internal
  type number, and plain decimal numbers.
- Trailing commas in arrays, maps, argument lists and enums. Std never uses them, so the parser rejects them.

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
`opBoolean`, `opDeleteBodies`.

- Sketches: lines, circles, arcs, points. Constraints are accepted but not solved (std's rectangle
  helpers build geometry that already satisfies them). Regions use spike S4's splitter approach.
- Evaluators: `evAxis`, `evLine`, `evBox3d`, `evVolume`, `evArea`, `evLength`, `evDistance` (minimum,
  without edge/face parameters), `evVertexPoint`, `evEdgeTangentLine(s)`, `evFaceTangentPlane(s)`,
  `evPlane`, `evSurfaceDefinition` and `evCurveDefinition` (planes, cylinders, spheres, lines, circles).
- Corpus: seven cases (bolt circle, turned shaft, filleted block, chamfered block, shelled box, boss
  pattern, evaluators). Every volume matches its hand-calculated value and every face/edge/vertex
  count matches Parasolid's conventions. Each case runs in 5-100 ms.

Not supported locally yet (each stops the run with the calling line): sweep, loft, draft, hole,
helix, thicken, split, mate connectors, sheet metal, variable/partial/conic fillets, chamfers other
than equal offsets, face patterns, evaluators on B-spline geometry, and sketch constraint solving.

To confirm against Onshape recordings:

- `evPlane` puts the plane origin at the face's centroid; Onshape doesn't document where it goes.
- A sketch makes one wire body and one region sheet body here, and connected sketch lines don't
  share vertices.
- Query results come back in creation order.
- "Through all" extrudes to a generous model extent rather than exactly through.
- Edge tangent parameters are uniform over the curve, which is arc length only for lines and circles.

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
