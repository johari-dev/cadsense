# Local CAD projects

A local CAD project is a folder project that reviews a CAD file in that folder instead of an Onshape
document. Nothing leaves the machine and there is no API quota, so the first import starts as soon as
the project is created. STEP and IGES files import directly. SolidWorks parts and assemblies import
through the SolidWorks installed on the machine (see [SolidWorks files](#solidworks-files)).

## Flow

1. Add project, then Local CAD file. Pick a folder with the desktop app's folder picker, or type
   its path where there is no picker (a browser, or a remote environment).
2. The dialog lists the STEP and IGES files under it (`localCad.files.list`). Pick one. The project
   name defaults to the folder name.
3. `localCad.projects.create` sets the project's `localCadSource` to that file and starts a sync.
   If the folder already belongs to a folder project, that project gets the CAD file instead of a
   duplicate being made. Onshape projects are rejected.
4. The new chat opens with the CAD panel loading. The sync result also carries the folder's file
   list, so project settings can switch to another file without a separate catalog refresh.
5. After editing and re-exporting the file, Sync in the CAD panel header or project settings imports
   the new revision.

### From the CAD panel

Every folder project offers the CAD panel. Until a model is imported (no file linked yet, or the
linked file's import failed, was interrupted, or never started), the panel shows the linked file and
any failure reason above a **Pick a file** button:

- The desktop app opens the native file dialog (`desktopBridge.pickFile`) in the project folder,
  filtered to STEP and IGES. With a WSL backend the dialog browses the distro over
  `\\wsl.localhost` and the chosen path is translated back, the same as the folder picker.
- A browser cannot read a path from a native dialog, so the button lists the folder's CAD files
  instead.

Either way `localCad.projects.setFile` links the file, absolute or workspace-relative, and imports
it. A plain folder project becomes a local CAD project this way.

## How it maps onto the Onshape snapshot model

Everything after import (CAD panel, agent tools, comments, `cad_diff`, retention) reads the same
`CadSnapshotManifest` that Onshape syncs produce. Local files fill the Onshape-shaped identity slots
with content-derived 24-hex IDs, so those consumers work unchanged:

| Slot             | Local value                                                  |
| ---------------- | ------------------------------------------------------------ |
| `host`           | `local`                                                      |
| `documentId`     | hash of the project ID                                       |
| `elementId`      | hash of the workspace-relative file path (one root per file) |
| `microversionId` | hash of the file bytes                                       |
| `configuration`  | `default`                                                    |

The catalog lists one root per CAD file, named by its relative path. Each occt mesh becomes one part
occurrence. Occurrence paths use the STEP product names, with `#2`, `#3` for repeated siblings, so
node IDs survive re-export when the structure does not change.

Tessellation uses [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade compiled
to WASM, LGPL-2.1, loaded unmodified from its own package) with Onshape's part tolerances: 0.5 mm
chord, 0.1 rad angle, meters. It runs in a worker thread so a large file does not stall the server,
and cancelling terminates the worker.

## Failure modes

| Failure                                               | Result                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Chosen file missing at create                         | `file-not-found`, no project change                          |
| File removed or renamed before a sync                 | Sync fails with a reason; the current snapshot is kept       |
| Path outside the folder (`..`, absolute, symlink out) | `outside-folder`                                             |
| Extension other than STEP or IGES                     | `unsupported-file`, and the file is never listed             |
| Corrupt file or occt parse failure                    | Sync fails; nothing is published                             |
| File parses to no triangles (wireframe only)          | Sync fails with a no-solid-geometry reason                   |
| File over 512 MiB                                     | Sync fails before reading it                                 |
| Cancel during import                                  | Worker terminated, outcome `cancelled`, nothing published    |
| Unchanged file synced again                           | Same comment model descriptor, so the comment revision holds |
| Changed file synced again                             | New microversion; the previous snapshot becomes the rollback |
| Repeated sibling names (three bolts)                  | Distinct, stable occurrence paths                            |
| Folder already used by a folder project               | That project gets the CAD source                             |
| Folder used by an Onshape project                     | `onshape-project`                                            |
| Agent run or CAD operation active                     | `busy`                                                       |
| Local CAD project deleted                             | Its snapshots are pruned instead of retained forever         |

## SolidWorks files

Nothing open source reads SolidWorks geometry reliably, but the person reviewing a `.SLDPRT` or
`.SLDASM` usually has SolidWorks. So these files import through the SolidWorks installed on the
machine, driven over COM. Nothing is uploaded. `SolidWorksBridge.ts` runs a PowerShell script that
compiles a small C# bridge against the installed SolidWorks API (found through its COM
registration) and reuses the compiled copy. On Windows the server runs it directly. In WSL it runs
the Windows host's PowerShell through interop and stages files under the Windows temp folder.

1. Collect the files. A part is one file. An assembly needs every file it uses, so
   `SolidWorksFiles.ts` reads the file list SolidWorks keeps inside the assembly
   (`swXmlContents/COMPINSTANCETREE`, which lists the whole hierarchy with each file's original
   path) and finds each one in the project folder by name, preferring the assembly's own
   directory. A missing file fails here, by name, before SolidWorks starts.
2. Hash them. The revision (`microversionId`) is a hash of every file. If the latest snapshot has
   the same revision it is reused as is, and SolidWorks does not start.
3. Copy them, flat, into a job folder under `%TEMP%\cadsense-solidworks`. SolidWorks only ever
   opens these copies, read-only, so it cannot touch the project folder, and it finds each
   reference beside the assembly.
4. In SolidWorks, open the copy, hide its window, resolve lightweight components, and walk the
   component tree: names, referenced configurations, suppression, visibility, and transforms (which
   SolidWorks gives relative to the root assembly). Each part used, in each configuration, is
   exported once to STEP AP214 from memory, which also covers 3D Interconnect inserts and virtual
   components that have no file of their own. Parts the latest snapshot already has, keyed by
   file hash and configuration, are skipped.
5. Back in the server, occt tessellates each part's STEP (two at a time) at the usual tolerances,
   and each part's bodies merge into one geometry. Every component becomes one part node placed by
   its SolidWorks transform, so the tree matches the SolidWorks feature tree, `cad_diff` sees real
   moves, and repeated components share geometry.

One assembly-wide STEP is not used because occt cannot tessellate a large one: the 151 MB export of
a 312-component robot came back with every mesh empty, while its 87 part exports all tessellate.

Rules the bridge keeps with SolidWorks:

- It opens only its own copies, read-only, and never saves.
- It closes only the documents it opened. If a file with the same name is already open in
  SolidWorks (perhaps with unsaved work), it refuses with a message naming it rather than read or
  close the user's document.
- Some add-ins ask whether to save every document that closes, even an unchanged read-only one.
  SOLIDWORKS CAM does this in a session the user started, and the close waits on the answer. While
  the bridge closes its own copy, it presses No on a SolidWorks dialog that names one of its copies.
  It never answers anything else.
- It sets the STEP export to AP214 with appearances, since the default AP203 drops colors, and
  restores both preferences afterwards, on failure too.
- If SolidWorks was already running, it attaches and leaves it running, visible or not. If Cadsense
  started it, it stays hidden and quits after the conversion, unless another conversion is already
  queued, in which case the next job inherits it and quits it in turn.
- Opening hidden from the start (`DocumentVisible(false)`) is avoided on purpose: such documents
  have no display data, and exporting their parts crashes SolidWorks. Hiding the window right after
  opening works, so a user's open SolidWorks shows the window for a moment at most.

### Failure modes

| Failure                                                | Result                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| Not on Windows or WSL, or SolidWorks not installed     | Fails saying SolidWorks is needed, or to save a STEP copy instead   |
| A file the assembly uses is not in the folder          | Fails before SolidWorks starts, naming the missing files            |
| Assembly with no readable file list (pre-2015, broken) | Fails before SolidWorks starts: SolidWorks 2015 or later is needed  |
| Two files in the folder share a referenced name        | The one in the assembly's directory wins, then the first by path    |
| Files over 512 MiB in total                            | Fails before reading them                                           |
| A same-named file is open in SolidWorks                | Fails asking to close it; the user's document is not touched        |
| SolidWorks cannot open or export the file              | Fails with SolidWorks' error; preferences restored, copies removed  |
| A part with only sketches                              | Left out of an assembly; on its own it fails as having no geometry  |
| Conversion running after 30 minutes                    | The bridge stops between parts and cleans up; fails as timed out    |
| Cancel during the conversion                           | The bridge stops between parts, closes its documents, and cleans up |
| Unchanged files synced again                           | The latest snapshot is reused; SolidWorks does not start            |
| One part of an assembly changed                        | New revision; only that part is exported and tessellated again      |
| Server killed mid-conversion                           | A SolidWorks that Cadsense started may stay running, hidden         |

## Limits

- Meshes come back in world coordinates, so moving a part between exports reads as
  `geometry-changed` in `cad_diff`, not `moved`. Both outdate comments the same way. SolidWorks
  imports place parts by their component transforms instead, so moves read as moves there.
- Mass, materials, and hidden flags are not read from STEP. Part colors are.
- SolidWorks files need SolidWorks on the machine running the Cadsense server (or its Windows host,
  for WSL). Component appearance overrides set in an assembly, and assembly-level features such as
  cuts, are not carried over: each part looks as it does in its own file. Other native formats
  (Fusion, Inventor) are not supported. Export STEP.
- A large assembly takes minutes the first time: the 312-component robot above exports 87 parts
  and tessellates 6.8 million triangles. Later syncs reuse every unchanged part.

## Verify

`LocalCadProjects.test.ts` runs the real orchestration engine, projections, snapshot store,
`CadUserOperations`, and occt worker against `testFixtures/dm1-id-214.stp` (CAx-IF test model, see
`testFixtures/README.md`) in a temporary folder. Generated SolidWorks containers cover missing files,
pre-2015 assemblies, and a machine without SolidWorks. With `CADSENSE_SOLIDWORKS_DIR` and
`CADSENSE_SOLIDWORKS_ASSEMBLY` (and optionally `CADSENSE_SOLIDWORKS_EMPTY_PART`) set, it also drives
the real SolidWorks: a conversion, an unchanged sync, a changed part re-exported alone, a missing
part, and a part with only sketches.

`apps/server/scripts/local-cad-project-e2e.ts` runs the dev app on a fresh data directory and drives
headless Chromium through the dialog, the first import, the CAD panel, a re-export with Sync, and
project settings. With `--ask` and `--model` it also sends a prompt to a real agent. With
`--solidworks` it converts real SolidWorks files, one project folder per case, including a part
converted while a user's SolidWorks session is open and must stay open. It keeps a screenshot per
step, the dev log, and `summary.json` under `--out`. It starts from a corrupt file so the panel's
file prompt has to recover, through the browser file menu. The dev server runs under `node --watch`,
whose workers post their own messages on the parent port; only this run covers that.

`apps/desktop/scripts/local-cad-file-picker-e2e.mjs` covers the native dialog in the dev desktop
app. It stubs Electron's `dialog.showOpenDialog` in the main process, records the options it was
called with, adds a plain folder project, presses Pick a file, and waits for the model. The WSL path
translation is shared with the folder picker but only runs on a Windows host, so this Linux run does
not cover it.
