# CADsense Bridge for Fusion

A Fusion add-in that takes plates from CADsense's CAM panel. **Send to Fusion** rebuilds the plate
as a solid, makes a milling setup with the plan's operations (pockets, bores, inside contours, then
the outside profile with tabs), generates the toolpaths, and reports Fusion's machining time and any
operation that failed back to CADsense. Post the G-code from Fusion as usual.

Sending the same plate again rebuilds the open document that holds it. The rebuild replaces the
setup too, so edits made to its operations in Fusion are lost.

## Install

1. In Fusion, open **Utilities > Add-Ins > Scripts and Add-Ins**.
2. Click **+** next to **My Add-Ins** and pick this `CADsenseBridge` folder.
3. Select **CADsense Bridge**, click **Run**, and tick **Run on Startup**.

Fusion has to run on the computer whose browser or desktop app shows CADsense. The add-in listens on
`127.0.0.1:27190` and nowhere else.

## What it builds

- **Setup**: the plate in a sheet with 0.25" of stock on each side, zeroed at the stock's top
  corner (`top 1`).
- **Tool**: a two-flute flat end mill of the CAM panel's diameter, at 18,000 rpm with the panel's
  feed and plunge.
- **Operations**: 2D Pocket per pocket, Bore per hole size (holes under 1.1× the tool are left to
  drill by hand, as in the plan), 2D Contour per cutout, and a 2D Contour profile with the panel's
  tab count. Every pass uses the panel's depth of cut, and through cuts go 0.01" into the spoilboard.

Outlines come from the part mesh, so curved edges arrive as short straight segments.
