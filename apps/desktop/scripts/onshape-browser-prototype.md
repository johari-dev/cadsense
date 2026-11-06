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

## Replay a browser-driven CAD sync

```sh
vp run prototype:onshape-browser-sync
```

This mode starts an existing local CAD project with the repository's offline plate fixture. The
fixture is an explicit baseline, not an earlier revision of the public Onshape document. Its first
ordinary Sync must reuse the same snapshot.

The prototype then intercepts one click on the existing Sync button. That click opens Onshape in
the app's browser, exports STEP, and saves the download to a staging file. The existing linked STEP
and CAD snapshot remain intact until the download passes validation. An atomic rename replaces the
linked file, then the ordinary CAD Sync handler imports it.

The report verifies that the project ID, linked file, and CAD root stay the same. The snapshot must
advance, and the old snapshot must remain available for rollback. A final ordinary Sync of the
unchanged downloaded file must reuse the new snapshot. This final check makes no new browser export.

Evidence is under `.cadsense/onshape-browser-sync-*`. `cadsense-browser-sync-proof.mp4` records the
full app. `baseline-cad.png` and `unchanged-sync.png` show the baseline and final unchanged sync.
`report.json` includes the before and after CAD state and both unchanged results.

The Sync click binding exists only in this runner's renderer session. A production Onshape project
still uses its existing API sync. This proof exercises browser acquisition followed by the existing
local CAD sync; it does not reproduce Onshape's native occurrence IDs or parametric history.

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

## Onboarding and the first import

Run `vp run prototype:onshape-browser-onboarding`. The runner starts an isolated Electron backend and serves the normal web frontend. Open the access URL it prints. The `/prototype/onshape-browser` route opens Step 2 directly, with the real AI reviewer status, so CAD setup can be tried without signing into an AI account.

Choose **I can't make an API key**, enter a public `cad.onshape.com` link and robot name, then click **Open browser and sync**. An owned Electron browser window opens the document and uses Onshape's export dialog. After the completed STEP passes validation, the existing local CAD create command adds the project and starts its first import. No API connection or baseline CAD file is required. If export fails, the form retains the link and name and no project is created.

The runner keeps the source URL beside its isolated state. The project's ordinary **Sync** button exports through that browser again, atomically replaces the validated linked STEP, then invokes the existing local CAD sync. The server continues to own snapshots and rollback retention. This preview supports export-enabled public documents; it does not promise access to documents whose website blocks export.

Use **Sync** in the CAD panel for website updates. The separate project-settings Sync imports the saved STEP and does not trigger a website export in this prototype.

The no-key integration and its transport are available only on this prototype host. The regular app does not install the prototype flag or expose the helper endpoints. The browser runs on the host machine; the CAD viewport renders in the visiting web browser. The access link authenticates HTTP and WebSocket traffic to the isolated backend without sending its Electron credential to the visiting browser.

Each website export writes an export-dialog screenshot and a JSON report with the downloaded byte count and SHA-256 under the printed evidence directory. To retain state across restarts, pass `--home-dir <that directory>`. The runner closes only its own Electron application and dev-server process group when stopped.
