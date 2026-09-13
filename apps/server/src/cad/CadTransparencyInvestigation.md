# Epsilon panel opacity

September 12, 2026. Onshape renders the marked Epsilon panel at 49.8% opacity,
while the supplied Cadsense screenshot shows it opaque. The import now preserves
part appearance metadata and restores omitted base-material opacity before
hashing and caching geometry.

## Source evidence

Inspected the [public Epsilon assembly](https://cad.onshape.com/documents/05760c4d8b40fba37db8fa48/w/f31b499c519e8471cced93dc/e/b53dde24ab8b46d679af9944)
and read the appearance of bodies loaded by its viewer. Selecting the panel in
the component tree confirmed its location.

| Field           | Observed value                           |
| --------------- | ---------------------------------------- |
| Instance        | `1678-24-P-0924 <2>`                     |
| Parent          | `1678-2024-E-0900 AMP <1>`               |
| Viewer body ID  | `RQJD`                                   |
| Occurrence path | `MF1BQyX4ddx34a7MT`, `MFpFO1KpNh5mspd17` |
| Display RGB     | `230, 230, 230`                          |
| Opacity         | `127/255`, approximately 49.8%           |
| Microversion    | `de54642171d191b245abc54f`               |

The microversion matches the [recorded robot import](CadThreeMfImport.md).
Of 1,215 loaded body occurrences, 24 have authored opacity below 255. The viewer's
temporary `transparentOccurrences` set was empty, so this is authored appearance.

## Import behavior

Previously, bulk assembly imports set appearance metadata to null. The browser
preserved transparency embedded in geometry but did not apply metadata opacity.
An opaque export therefore stayed opaque, even when metadata was available.

[OnshapeSnapshotMetadata](../onshape/OnshapeSnapshotMetadata.ts) now supplies both
acquisition paths with metadata grouped by immutable Part Studio and
configuration. Linked-document requests retain version and microversion checks.
The metadata is saved in the export checkpoint, so a download or publication
retry does not fetch it again.

[OnshapeGeometryAppearance](../onshape/OnshapeGeometryAppearance.ts) applies missing
opacity to an opaque material whose RGB matches the part's display RGB or its
linear conversion. It adds `alphaMode: "BLEND"` and the source alpha factor.
Different face colors, authored alpha, textures, vertex colors, and material
extensions retain their own appearance. The binary geometry remains unchanged.

The repair runs before asset hashing for both 3MF and glTF acquisition, including
fallback geometry. Parts with different opacity produce different material
assets without mutating shared geometry. No renderer override is needed.

## Existing snapshots and request cost

Re-sync an existing model to acquire the corrected appearance. Both import
profiles, plus the companion glTF profile, have new opacity-version identifiers.
They invalidate completed acquisition checkpoints and old geometry-cache keys.
Historical snapshots remain immutable.

A new bulk assembly export requires one metadata request per distinct Part
Studio configuration. Linked versions without a microversion in the metadata
also need a version-resolution request, shared within that acquisition. A
companion glTF export has its own metadata acquisition. Unchanged syncs still
use one revision check after the corrected snapshot has been published.

## Verification and limits

The [acquisition regressions](../onshape/OnshapeBulkAcquisition.test.ts) verify
source opacity in the manifest and translucent base faces in the stored GLB,
while a face-color override remains opaque. The
[material tests](../onshape/OnshapeGeometryAppearance.test.ts) cover display and
linear RGB, endpoint colors, zero opacity, independent material assets,
idempotence, geometry preservation, and authored material overrides.

The initial reproduction failed with expected opacity `0.4980392156862745`,
actual `1`. The corresponding stored-GLB regression passes with the repair.
An embedded-alpha control also passed through the existing 3MF reader,
normalizer, batching, Three.js GLTFLoader, and browser material preparation.
The renderer's `alpha: false` controls canvas background transparency and does
not disable transparent parts.

The affected snapshot's saved GLB and raw export were unavailable locally.
The configured Onshape API returned HTTP 402, so no fresh export was submitted.
The synthetic regressions establish the repaired behavior but do not establish
which exporter omitted the panel's opacity or visually validate a new live
Epsilon import.
