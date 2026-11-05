# Replay the Onshape browser export prototype

Run this command from the repository root with dependencies installed, a desktop display, and
`ffmpeg` on `PATH`:

```sh
vp run prototype:onshape-browser
```

The command builds the desktop runtime, starts an isolated development renderer and backend, and
opens the real CADsense app. It uses a fresh profile under `.cadsense/onshape-browser-export-*`.
It does not use the daily-driver profile or Onshape API keys.

The prototype opens the public DriveInt assembly in CADsense's browser, chooses STEP in Onshape's
Export dialog, and downloads the file. It checks the STEP header, footer, byte count, and SHA-256.
It then imports that file through CADsense's local CAD UI and captures the displayed model.

The last output line gives the evidence directory. Open these files there:

- `cadsense-browser-export-proof.mp4` records the complete app window, including the local import.
- `onshape-browser-recording.mp4` comes from CADsense's existing in-app browser recorder.
- `export-dialog.png` and `imported-cad.png` show the export settings and final model.
- `report.json` records the source URL, steps, download checksum, final UI, and any failure.
- `Onshape browser export/onshape-browser-proof.step` is the downloaded CAD file.

The command closes only the app and dev process it starts. It preserves its evidence and scratch
state. A failed run exits with a nonzero code and saves `failure.png` when the renderer is available.

To try another document, pass its URL to the script:

```sh
node apps/desktop/scripts/onshape-browser-prototype.mjs --url 'https://cad.onshape.com/documents/...'
```

Use `--skip-build` when the current server and desktop bundles are already built.

## What the prototype changes

All download handling lives in the script. It attaches an Electron `will-download` listener to the
isolated browser session and gives the download a path in the scratch project. Native folder and
file pickers return that run's folder and downloaded STEP file. This makes the run repeatable while
the real application commands still create the project and import the CAD file.

Browser actions use CADsense's existing `desktopBridge.preview.automation` operations. The script
uses DOM clicks and native select change events through browser evaluation. It makes no direct
Onshape export HTTP requests. Onshape's website handles its own backend requests and export polling.

This is throwaway prototype code. It adds no product UI or production download service. A product
implementation still needs scoped download ownership, cancellation, progress, and workspace path
validation. Documents must permit browser export. The demonstrated anonymous access does not
establish that every public document permits anonymous export.

On Linux, this run uses SwiftShader because the verification environment has no usable hardware
WebGL adapter. The video demonstrates functionality, not graphics performance.
