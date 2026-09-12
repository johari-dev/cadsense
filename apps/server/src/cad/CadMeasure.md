# CAD measurement

`cad_measure` reads the pinned snapshot in the active CAD session. Every request includes `snapshotId` and `expectedRevision` from `cad_context`. A stale value fails with `revision-conflict`.

Point distance accepts two explicit coordinates:

```json
{
  "snapshotId": "00000000-0000-4000-8000-000000000002",
  "expectedRevision": 7,
  "mode": "point-distance",
  "from": { "space": "world", "point": [0, 0, 0] },
  "to": {
    "space": "part",
    "occurrenceId": "<part occurrence ID from cad_hierarchy>",
    "point": [0.01, 0, 0]
  }
}
```

Coordinates use meters. World coordinates use the original assembled placement with Z up. Part coordinates precede the occurrence transform and use the part's CAD axes. The result retains the supplied points and resolves both to assembled world coordinates. Explicit points are unverified inputs. Display coordinates from an exploded capture are not valid assembled world coordinates.

Surface measurement accepts two part occurrences:

```json
{
  "snapshotId": "00000000-0000-4000-8000-000000000002",
  "expectedRevision": 7,
  "mode": "surface-clearance",
  "fromOccurrenceId": "<first part occurrence ID>",
  "toOccurrenceId": "<second part occurrence ID>"
}
```

The result is the unsigned minimum distance between the cached triangle surfaces. Original occurrence placements and GLB node transforms apply to every triangle. Visibility, isolation, explosion, and camera settings do not affect the calculation. Suppressed occurrences and assembly containers have no measurable part geometry.

A positive surface distance does not exclude solid containment. Zero does not distinguish touching surfaces from intersecting surfaces. Tessellation error is unknown, so the value is not a manufacturing tolerance, signed clearance, or penetration depth.

A successful result has `status: "measured"`, `distanceMeters`, and two `closestPoints` in assembled world coordinates. Both successful and unknown results include snapshot, root, microversion, view revision, units, coordinate convention, geometry provenance, and accuracy limitations. Provenance identifies each requested occurrence, its geometry key, cached asset SHA-256, and tessellation profile when available.

`status: "unknown"` has a reason and null distance and points. Reasons distinguish missing occurrences, missing geometry, unsupported geometry, invalid geometry, empty geometry, exhausted budgets, and numeric failure. Unknown results never return a partial candidate as the minimum.

The fixed limits are:

- Two part occurrences per surface request.
- 128 MiB per cached GLB, 10,000 visited GLB nodes, and 100,000 triangles per occurrence.
- 250,000 combined tree-node and triangle comparisons per surface request.

The geometry reader supports static triangle primitives, indexed or unindexed positions, normalized and strided accessors, repeated mesh instances, and affine transforms. Sparse accessors, animation, skins, morph targets, compressed geometry, and non-triangle primitives return unknown. Collapsed triangles retain their edges and points.

Bounding boxes only prune triangle comparisons. The solver covers vertex-face, edge-edge, and edge-face cases and computes with Float64 arithmetic after coordinate scaling. Arithmetic outside the supported numeric range returns unknown. Neither floating-point error nor mesh approximation has a certified error bound.

The tool reads local snapshot assets and does not write to Onshape or change the CAD view.
