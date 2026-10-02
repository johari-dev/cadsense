# Local CAD projects

A local CAD project is a folder project that reviews a CAD file in that folder instead of an Onshape
document. Nothing leaves the machine and there is no API quota, so the first import starts as soon as
the project is created.

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

## Limits

- Meshes come back in world coordinates, so moving a part between exports reads as
  `geometry-changed` in `cad_diff`, not `moved`. Both outdate comments the same way.
- Mass, materials, and hidden flags are not read from STEP. Part colors are.
- Native formats (SolidWorks, Fusion, Inventor) are not supported. Export STEP.

## Verify

`LocalCadProjects.test.ts` runs the real orchestration engine, projections, snapshot store,
`CadUserOperations`, and occt worker against `testFixtures/dm1-id-214.stp` (CAx-IF test model, see
`testFixtures/README.md`) in a temporary folder.

`apps/server/scripts/local-cad-project-e2e.ts` runs the dev app on a fresh data directory and drives
headless Chromium through the dialog, the first import, the CAD panel, a re-export with Sync, and
project settings. With `--ask` and `--model` it also sends a prompt to a real agent. It keeps a
screenshot per step, the dev log, and `summary.json` under `--out`. It starts from a corrupt file so
the panel's file prompt has to recover, through the browser file menu. The dev server runs under
`node --watch`, whose workers post their own messages on the parent port; only this run covers that.

`apps/desktop/scripts/local-cad-file-picker-e2e.mjs` covers the native dialog in the dev desktop
app. It stubs Electron's `dialog.showOpenDialog` in the main process, records the options it was
called with, adds a plain folder project, presses Pick a file, and waits for the model. The WSL path
translation is shared with the folder picker but only runs on a Windows host, so this Linux run does
not cover it.
