# CAD hierarchy

`cad_hierarchy` reads one parent's direct children in the selected root, a page at a time. Each entry has the child's occurrence ID, name, kind, whether it has children, visibility, suppression, and for parts the material and `massKg` when Onshape supplied them. Omit `parentOccurrenceId` to read the top level; pass an entry's `occurrenceId` to read below it.

## Paging

Children are listed in snapshot order, so cursors are plain offsets bound to `snapshotId` and the parent, the same scheme as `cad_checks`. Pages default to 100 entries and cap at 200.

Every page must come back inline. Claude saves an MCP result over its output limit to a file, and reading that file takes a shell command that waits on a permission prompt. On a 361-component elevator cascade, a 200-entry page was 65 KB; Opus saved it to a file, parsed it with `python3`, and the review sat on that approval for 16 minutes. So a page names its parent once in `parentOccurrenceId` instead of on every entry (every child on a page shares it; that was 13 KB of the 65), and stops adding entries before its JSON passes `CAD_TOOL_PAGE_BYTES` (32 KiB), the budget `cad_checks` uses. A capped page holds fewer entries than `limit` and its `nextCursor` continues from the first one left out.

Ways paging can fail, each covered by `CadHierarchy.test.ts`:

- A page, even at `limit: 200` with long part names, serializes past `CAD_TOOL_PAGE_BYTES`.
- The parent occurrence ID repeats on every entry, or the page names the wrong parent (a top-level read must say `null`).
- The byte cap drops or repeats an entry across pages.
- Entries at the 4096-character name and material limits produce an empty page or stop the cursor from advancing.
- The byte cap shortens a page that already fits, so small parents need extra calls.
- Cursors from another parent or snapshot, or a `limit` over 200, are accepted. `CadViewState.test.ts` covers this one with the other cursor checks.

## Verification

- `CadHierarchy.test.ts` covers the failure list above, except where noted.
- End to end: run a Claude review of an assembly with more than 200 children under one parent and confirm no `cad_hierarchy` result lands in the session's `tool-results` directory and the thread records no command approval.
