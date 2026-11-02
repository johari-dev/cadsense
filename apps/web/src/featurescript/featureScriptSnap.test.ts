import { describe, expect, it } from "vite-plus/test";
import {
  snapToOutline,
  type ClickedSurface,
  type ProjectedPoint,
  type ProjectedSegment,
} from "./featureScriptSnap";

/**
 * Snapping a click to the clicked body's outline: its B-rep edges as drawn and its vertices, the
 * way Onshape picks only what's under the cursor. Ways this goes wrong: a click anywhere snaps to
 * an edge however far, so an edge-only input picks something the person didn't point at; an edge
 * or vertex behind the clicked surface (a pocket's, seen through the top face) wins because it's
 * near on screen; the snapped point isn't on the edge (interpolated on screen without perspective,
 * so a long edge receding from the camera puts it millimeters off and it reads as hidden); a point
 * where an edge's segments meet counts as a vertex; a vertex where edges meet without a corner (a
 * fillet's tangent vertex) can't be picked; an edge is named by the point on the chord drawn for
 * it, inside a curve, rather than by its exact middle; seen at a grazing angle, a click on the top face a
 * pixel behind its front edge is millimeters from it, and the edge reads as hidden.
 */
const point = (
  screen: readonly [number, number],
  world: readonly [number, number, number],
  depth = 1,
): ProjectedPoint => ({ screen, world, depth });
/** A segment of a drawn edge; `exact` is the edge's middle, by default the segment's. */
const segment = (
  a: readonly [number, number],
  b: readonly [number, number],
  worldA: readonly [number, number, number],
  worldB: readonly [number, number, number],
  depths: readonly [number, number] = [1, 1],
  exact: readonly [number, number, number] = [
    (worldA[0] + worldB[0]) / 2,
    (worldA[1] + worldB[1]) / 2,
    (worldA[2] + worldB[2]) / 2,
  ],
): ProjectedSegment => ({ a: point(a, worldA, depths[0]), b: point(b, worldB, depths[1]), exact });

/** A click on a horizontal face at `point`, seen from straight above. */
const fromAbove = (point: readonly [number, number, number], worldPerPixel = 0.0005) =>
  ({
    point,
    normal: [0, 0, 1],
    eye: [point[0], point[1], point[2] + 1],
    worldPerPixel,
  }) satisfies ClickedSurface;

// A box corner seen from above: three edges meet at screen (100, 100), world (0, 0, 0).
const corner = {
  edges: [
    segment([100, 100], [200, 100], [0, 0, 0], [0.1, 0, 0]),
    segment([100, 100], [100, 200], [0, 0, 0], [0, 0.1, 0]),
    segment([100, 100], [80, 80], [0, 0, 0], [0, 0, 0.02]),
  ],
  vertices: [point([100, 100], [0, 0, 0])],
};

describe("snapToOutline", () => {
  it("snaps a click near an edge to the point on it, and ignores one too far away", () => {
    const near = snapToOutline(corner, [150, 103], fromAbove([0.05, 0.003, 0]));
    expect(near.edge?.at.map((n) => +n.toFixed(6))).toEqual([0.05, 0, 0]);
    expect(snapToOutline(corner, [150, 120], fromAbove([0.05, 0.02, 0])).edge).toBeNull();
  });

  it("finds the point on an edge receding from the camera with perspective", () => {
    // From depth 1 to depth 3: halfway on screen is a quarter of the way along the edge.
    const receding = {
      edges: [segment([0, 0], [100, 0], [0, 0, 0], [1, 0, 0], [1, 3])],
      vertices: [],
    };
    expect(snapToOutline(receding, [50, 1], fromAbove([0.25, 0.001, 0], 0.01)).edge?.at).toEqual([
      0.25, 0, 0,
    ]);
  });

  it("ignores an edge or vertex behind the clicked surface, however near on screen", () => {
    // The click hits the top face at z = 0.02; the edge and vertex under it are 15 mm below.
    const hidden = {
      edges: [segment([0, 50], [300, 50], [0, 0.05, 0.005], [0.3, 0.05, 0.005])],
      vertices: [point([150, 50], [0.15, 0.05, 0.005])],
    };
    expect(snapToOutline(hidden, [150, 51], fromAbove([0.15, 0.051, 0.02]))).toEqual({
      edge: null,
      vertex: null,
    });
  });

  it("finds a vertex it's given within a few pixels, and only those", () => {
    expect(snapToOutline(corner, [104, 103], fromAbove([0.004, 0.003, 0])).vertex).toEqual([
      0, 0, 0,
    ]);
    expect(snapToOutline(corner, [108, 106], fromAbove([0.008, 0.006, 0])).vertex).toBeNull();
    // An arc drawn in 10 degree steps: where its segments meet isn't a vertex.
    const arc = {
      edges: Array.from({ length: 9 }, (_, i) => {
        const at = (k: number) =>
          [Math.cos((k * Math.PI) / 18), Math.sin((k * Math.PI) / 18)] as const;
        const [x0, y0] = at(i);
        const [x1, y1] = at(i + 1);
        return segment(
          [x0 * 100, y0 * 100],
          [x1 * 100, y1 * 100],
          [x0 / 10, y0 / 10, 0],
          [x1 / 10, y1 / 10, 0],
        );
      }),
      vertices: [],
    };
    const [mx, my] = [Math.cos(Math.PI / 6) * 100, Math.sin(Math.PI / 6) * 100];
    const onArc = snapToOutline(arc, [mx, my], fromAbove([mx / 1000, my / 1000, 0]));
    expect(onArc.vertex).toBeNull();
    expect(onArc.edge).not.toBeNull();
  });

  it("finds a fillet's tangent vertex, where a straight edge runs on into an arc", () => {
    // A top edge along x meets a fillet's arc at (0.05, 0, 0) in the same direction.
    const tangent = {
      edges: [
        segment([0, 100], [50, 100], [0, 0, 0], [0.05, 0, 0]),
        segment([50, 100], [60, 101], [0.05, 0, 0], [0.06, 0.001, 0]),
      ],
      vertices: [point([50, 100], [0.05, 0, 0])],
    };
    expect(snapToOutline(tangent, [52, 102], fromAbove([0.052, 0.002, 0])).vertex).toEqual([
      0.05, 0, 0,
    ]);
  });
  it("names the snapped edge by its exact middle, not by a point on the chord drawn for it", () => {
    // A circle's arc drawn as one chord, 0.05 mm inside the curve at its middle.
    const arc = {
      edges: [segment([0, 0], [100, 0], [0, 0, 0], [0.01, 0, 0], [1, 1], [0.005, 0.00005, 0])],
      vertices: [],
    };
    expect(snapToOutline(arc, [50, 1], fromAbove([0.005, 0.0001, 0])).edge).toEqual({
      at: [0.005, 0, 0],
      exact: [0.005, 0.00005, 0],
    });
  });

  it("takes the front edge clicked a pixel behind at a grazing angle, not an edge under the face", () => {
    // A block's top (z = 10 mm) seen from 10 degrees above, 120 mm off: a click one pixel above its
    // front edge (y = 0) meets the top 2.9 mm behind it, a pixel there spanning 0.17 mm.
    const elevation = (10 * Math.PI) / 180;
    const surface = {
      point: [0.02, 0.00293, 0.01],
      normal: [0, 0, 1],
      eye: [0.02, -0.12 * Math.cos(elevation), 0.01 + 0.12 * Math.sin(elevation)],
      worldPerPixel: 0.00017,
    } satisfies ClickedSurface;
    const front = {
      edges: [segment([0, 300], [800, 300], [0, 0, 0.01], [0.04, 0, 0.01])],
      vertices: [],
    };
    expect(snapToOutline(front, [400, 299], surface).edge?.at).toEqual([0.02, 0, 0.01]);
    // A pocket's edge 0.5 mm under the top, 3 mm behind the front, on the same pixel row.
    const pocket = {
      edges: [segment([0, 300], [800, 300], [0, 0.003, 0.0095], [0.04, 0.003, 0.0095])],
      vertices: [],
    };
    expect(snapToOutline(pocket, [400, 299], surface).edge).toBeNull();
  });
});
