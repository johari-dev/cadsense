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
- `test/broken/`: files with syntax errors; each lists the exact diagnostics it must produce.
- `spikes/`: throwaway measurements from milestone M0. Results are below.

## Language notes

Sources: [Lexical conventions](https://cad.onshape.com/FsDoc/tokens.html),
[Syntax and semantics](https://cad.onshape.com/FsDoc/syntax.html),
[Top-level constructs](https://cad.onshape.com/FsDoc/top-level.html), and std itself.

- Semicolons are never optional. Strings use `'` or `"`, with escapes `\b \t \n \f \r \uXXXX` and
  the matching quote. Numbers are decimal floats plus `inf`.
- Keywords: `annotation enum export function import operator precondition predicate returns type
typecheck typeconvert as is new break const continue for in return var while false inf true
undefined catch throw try`, reserved `assert case default do switch`. `switch (x) { k : v }` is
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
10. **Keywords as names.** `definition.type`, `x.in`, `{ type : 1 }`. Guard: tree-shape tests.

### To confirm against Onshape (conformance recordings)

- `as` precedence relative to arithmetic (`a + b as T`).
- `??` precedence relative to `||`.
- `^` associativity and unary minus (`-2^2`, `2^3^2`).
- Map key order and number formatting in `toString`.
- Trailing commas in arrays, maps, argument lists and enums. Std never uses them, so the parser rejects them.

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

- Parse only for now: all 276 files of std 3083 (150k lines, 7 MB) parse with zero diagnostics in
  ~230 ms, single-threaded, no cache. That's well under the 2 s threshold for adding an AST cache.
- Evaluating std's top level needs the interpreter (M3); that half of S2 is measured there.

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
