import { describe, expect, it } from "vite-plus/test";
import { pickKind, pickQuery, type PickHit } from "./featureScriptDialog";

/**
 * Picking faces, edges, vertices and parts: a click on the model becomes a `qClosestTo` query of
 * the clicked face, named by its probe (a point inside it on its true surface, from the GLB), and
 * of the clicked part's edge or vertex the click snapped to (featureScriptSnap), named by its exact
 * point. Ways this goes wrong: a face is named by where the click met its drawn triangles, which
 * sit inside a curved face, so a click by its rim names the face beyond, or two stacked parts'
 * discs; an edge is named by a point on its chord; an edge or vertex two touching parts share
 * (blocks stacked) picks both parts' at once; an edge-only input picks an edge from a click on a
 * face's middle; a filter that takes faces or edges (fillet, chamfer, a revolve axis) can never get
 * an edge; a vertex-only filter makes a mate connector its filter rejects; a body filter that only
 * takes wires or points, which a click on a face can't give, offers a pick.
 */
describe("pickKind", () => {
  it("takes the face or the edge clicked for filters that allow both", () => {
    for (const filter of [
      "EntityType.EDGE || EntityType.FACE",
      "((ActiveSheetMetal.NO && ((EntityType.EDGE && EdgeTopology.TWO_SIDED) || EntityType.FACE)) || (EntityType.EDGE && ActiveSheetMetal.YES)) && ConstructionObject.NO",
      "QueryFilterCompound.ALLOWS_AXIS",
      "QueryFilterCompound.ALLOWS_DIRECTION",
    ])
      expect(pickKind(filter), filter).toEqual({ kind: "faceOrEdge" });
  });

  it("takes only an edge for edge and curve filters", () => {
    for (const filter of [
      "EntityType.EDGE",
      "EntityType.EDGE && GeometryType.LINE",
      "GeometryType.LINE",
      "EntityType.EDGE && (GeometryType.CIRCLE || GeometryType.ARC)",
    ])
      expect(pickKind(filter), filter).toEqual({ kind: "edge" });
  });

  it("takes a vertex for vertex-only filters, and the clicked part for solid and sheet filters", () => {
    expect(pickKind("EntityType.VERTEX")).toEqual({ kind: "vertex" });
    expect(pickKind("EntityType.VERTEX && SketchObject.NO")).toEqual({ kind: "vertex" });
    for (const filter of [
      "EntityType.BODY",
      "EntityType.BODY && BodyType.SOLID",
      "EntityType.BODY && (BodyType.SOLID || BodyType.SHEET) && ModifiableEntityOnly.YES",
    ])
      expect(pickKind(filter), filter).toEqual({ kind: "body" });
    expect(pickKind("EntityType.BODY && BodyType.WIRE")).toBeNull();
    expect(pickKind("EntityType.BODY && BodyType.POINT")).toBeNull();
  });
});

describe("pickQuery", () => {
  const drawnFaces =
    "qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO)";
  // A click that landed on a face whose probe (from the GLB) is at (60, 30, 20) mm.
  const onFace: PickHit = {
    point: [0.05, 0.04, 0.02],
    normal: [0, 0, 1],
    face: [0.06, 0.03, 0.02],
    edge: null,
    vertex: null,
  };
  // Snapped on screen to (50, 0, 20) mm on an edge whose middle is (55, 0, 20) mm.
  const onEdge: PickHit = { ...onFace, edge: { at: [0.05, 0, 0.02], exact: [0.055, 0, 0.02] } };
  const onCorner: PickHit = { ...onEdge, vertex: [0.1, 0.1, 0.02] };

  // The clicked face: the drawn face nearest its probe, or of several there, the clicked point's.
  const clickedFace = `qClosestTo(qClosestTo(${drawnFaces}, vector(60, 30, 20) * millimeter), vector(50, 40, 20) * millimeter)`;

  it("names the clicked face by its probe, not by where the click met its drawn triangles", () => {
    expect(pickQuery("face", onFace)).toEqual({ query: clickedFace, at: [0.05, 0.04, 0.02] });
    // A face without a probe (a GLB from before them) is named by the clicked point.
    expect(pickQuery("face", { ...onFace, face: null })?.query).toBe(
      `qClosestTo(qClosestTo(${drawnFaces}, vector(50, 40, 20) * millimeter), vector(50, 40, 20) * millimeter)`,
    );
  });

  it("picks the clicked part's edge at its exact middle, shown where the click snapped", () => {
    expect(pickQuery("edge", onEdge)).toEqual({
      query: `qClosestTo(qOwnedByBody(qOwnerBody(${clickedFace}), EntityType.EDGE), vector(55, 0, 20) * millimeter)`,
      at: [0.05, 0, 0.02],
    });
    expect(pickQuery("edge", onFace)).toBeNull();
  });

  it("picks the edge when a face-or-edge input's click is on one, else the face", () => {
    expect(pickQuery("faceOrEdge", onEdge)?.query).toBe(pickQuery("edge", onEdge)?.query);
    expect(pickQuery("faceOrEdge", onFace)).toEqual(pickQuery("face", onFace));
  });

  it("picks the clicked part's corner, and the part that owns the clicked face", () => {
    expect(pickQuery("vertex", onCorner)).toEqual({
      query: `qClosestTo(qOwnedByBody(qOwnerBody(${clickedFace}), EntityType.VERTEX), vector(100, 100, 20) * millimeter)`,
      at: [0.1, 0.1, 0.02],
    });
    expect(pickQuery("vertex", onEdge)).toBeNull();
    expect(pickQuery("body", onFace)?.query).toBe(`qOwnerBody(${clickedFace})`);
  });
});
