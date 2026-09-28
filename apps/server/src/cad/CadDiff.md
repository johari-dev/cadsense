# CAD diff

`cad_diff` lets a review cover the work since the last review instead of the whole assembly. It compares two retained snapshots of the selected root and reports what changed, so the agent inspects changed components and reuses unchanged findings through `cad_comments_publish` with `kind: "reuse"`.

## Inputs and defaults

`targetSnapshotId` defaults to the selected root's current snapshot. `baseSnapshotId` defaults to the newest retained snapshot created before the target; `baseSelection` in the result explains that choice, including which comments inspected it. Without an earlier retained snapshot the tool returns `invalid-operation` saying this is the first review, and the agent inspects the model in full.

Retention (`CadSnapshotRetention.ts`) keeps a root's current and rollback snapshots and every snapshot a live chat's comments reference. `retainedSnapshots` lists exactly the candidates the tool derives from that rule for this root and chat, with `createdAt`, Onshape `microversionId`, the retaining roles, and comment numbers. Other chats' comment snapshots are retained too but omitted because their findings cannot be reused here. An explicit `baseSnapshotId` outside that list still works while the manifest exists, and `baseSelection` warns that it may disappear.

## Matching and categories

Occurrences match by `occurrencePath`, which survives reimport; node IDs are root-qualified hashes of that path and are returned on both sides as `baseOccurrenceId` and `targetOccurrenceId`. Each entry is `added`, `removed`, or `modified` with one or more `changes`:

- `moved`: the placement relative to the parent occurrence differs by more than 1e-6. Manifest transforms are absolute, so comparing relative placements reports a moved subassembly once instead of every descendant.
- `geometry-changed`: the source part's geometry key differs and the exported GLB bytes differ. A part studio edit changes the key of every part in that studio; identical bytes prove the shape did not change. Keys without geometry (suppressed on both sides) compare by key alone.
- `renamed`, `suppression-changed`, `visibility-changed`: the instance name, suppression flag, or default visibility differs. `previousName` carries the base name for renames.

`counts` totals each category plus `unchanged`. Entries are ordered added, removed, modified, and parents before children. Pages default to 100 entries with a cursor bound to the snapshot pair; a cursor from another pair is rejected. The diff is linear in the node count and is cached per activation, so paging never reloads a snapshot. Part metadata such as color and material is not compared.

## Verification

`CadDiff.test.ts` covers every category, repeated instances of one part, sub-epsilon noise and reimported identical models, cursor binding, and default base choice. `CadViewing.test.ts` runs the tool through the real activation path with a committed comment and a second sync, checking the rollback and comment-referenced base, retained snapshot listing, cached paging, and the first-review error. Transport tests enumerate `cad_diff` among the twelve CAD tools with the read-only hint.
