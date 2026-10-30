import { describe, expect, it } from "vite-plus/test";
import {
  inputExpression,
  listExpression,
  newPickId,
  pickExpression,
  pickKind,
  pointExpression,
} from "./featureScriptDialog";

/**
 * What a person types in the feature dialog becomes a FeatureScript expression the server
 * evaluates. Ways this goes wrong: a bare number read in the wrong unit (meters, radians) when the
 * dialog shows millimeters and degrees; another unit typed (in, cm, rad) ignored or mangled;
 * negative or exponent numbers rejected; an expression someone typed on purpose wrapped in a unit;
 * a string with quotes or backslashes producing broken source; clearing a field sending "" instead
 * of going back to the default; a picked point written with float noise or in meters as if it were
 * millimeters; a pick on a curved face matching nothing because the click is on its tessellation;
 * several picks not combined into one query.
 */
describe("inputExpression", () => {
  it("reads bare lengths in millimeters and angles in degrees, as the dialog shows them", () => {
    expect(inputExpression("length", "5.5")).toBe("5.5 * millimeter");
    expect(inputExpression("length", "5.5 mm")).toBe("5.5 * millimeter");
    expect(inputExpression("angle", "30")).toBe("30 * degree");
    expect(inputExpression("angle", "30 deg")).toBe("30 * degree");
  });

  it("honors other units, negatives and exponents", () => {
    expect(inputExpression("length", "2 in")).toBe("2 * inch");
    expect(inputExpression("length", "1.5cm")).toBe("1.5 * centimeter");
    expect(inputExpression("length", "-3 m")).toBe("-3 * meter");
    expect(inputExpression("length", "1e-3 ft")).toBe("1e-3 * foot");
    expect(inputExpression("angle", "0.5 rad")).toBe("0.5 * radian");
    expect(inputExpression("integer", "6")).toBe("6");
    expect(inputExpression("real", "-0.25")).toBe("-0.25");
  });

  it("passes anything else through as FeatureScript", () => {
    expect(inputExpression("length", "2 * inch + 1 * millimeter")).toBe(
      "2 * inch + 1 * millimeter",
    );
    expect(inputExpression("integer", "3 + 3")).toBe("3 + 3");
    expect(inputExpression("enum", "BoundingType.BLIND")).toBe("BoundingType.BLIND");
    expect(inputExpression("query", "qEverything(EntityType.FACE)")).toBe(
      "qEverything(EntityType.FACE)",
    );
  });

  it("quotes strings safely and reads booleans", () => {
    expect(inputExpression("string", 'a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(inputExpression("boolean", "true")).toBe("true");
    expect(inputExpression("boolean", "false")).toBe("false");
  });

  it("returns null for an empty field, so the input goes back to its default", () => {
    expect(inputExpression("length", "  ")).toBeNull();
    expect(inputExpression("string", "")).toBeNull();
  });
});

describe("pickExpression", () => {
  // A click lands on the tessellation, up to its deflection off a curved face, so the query asks for
  // the closest face rather than one containing the point.
  // The faces the preview draws: the base's and any an earlier feature made.
  const drawn =
    "qSketchFilter(qConstructionFilter(qEverything(EntityType.FACE), ConstructionObject.NO), SketchObject.NO)";
  it("finds the drawn face nearest a picked point, given in meters, as millimeters", () => {
    expect(pickExpression([[0.05, 0.03, 0.01]])).toBe(
      `qClosestTo(${drawn}, vector(50, 30, 10) * millimeter)`,
    );
    expect(pickExpression([[0.0123456789, -0.0000000001, 0.1]])).toBe(
      `qClosestTo(${drawn}, vector(12.3457, 0, 100) * millimeter)`,
    );
  });

  it("combines several picks into one query", () => {
    expect(
      pickExpression([
        [0, 0, 0.01],
        [0.1, 0, 0.005],
      ]),
    ).toBe(
      `qUnion([qClosestTo(${drawn}, vector(0, 0, 10) * millimeter), qClosestTo(${drawn}, vector(100, 0, 5) * millimeter)])`,
    );
  });
});

/**
 * Picking a point and editing a list. Ways this goes wrong: a direction or axis input that can't be
 * picked although a planar face gives it; a point input offered faces, or a vertex-only input given
 * a mate connector body its filter rejects; an edge input offered picks that make queries the
 * feature refuses; two picked points sharing an id, or an id the server's pattern rejects; a list
 * item's unset inputs written as something other than "missing" (the runtime fills defaults); list
 * order lost; an empty list sent as anything but [].
 */
describe("pickKind", () => {
  it("picks faces for face, plane, direction and axis filters, and with no filter", () => {
    for (const filter of [
      null,
      "EntityType.FACE",
      "(EntityType.FACE && GeometryType.PLANE) && ConstructionObject.NO",
      "QueryFilterCompound.ALLOWS_DIRECTION",
      "QueryFilterCompound.ALLOWS_AXIS",
      "GeometryType.CYLINDER",
      "EntityType.FACE || EntityType.VERTEX",
    ])
      expect(pickKind(filter), String(filter)).toEqual({ kind: "face" });
  });

  it("picks points as mate connectors where connectors are allowed, else as their vertex", () => {
    expect(pickKind("QueryFilterCompound.ALLOWS_VERTEX")).toEqual({
      kind: "point",
      entity: "BODY",
    });
    expect(pickKind("EntityType.VERTEX || BodyType.MATE_CONNECTOR")).toEqual({
      kind: "point",
      entity: "BODY",
    });
    expect(pickKind("EntityType.VERTEX")).toEqual({ kind: "point", entity: "VERTEX" });
  });

  it("offers no pick for filters a click can't satisfy", () => {
    expect(pickKind("EntityType.EDGE")).toBeNull();
    expect(pickKind("EntityType.BODY && BodyType.SOLID")).toBeNull();
    expect(pickKind("GeometryType.LINE")).toBeNull();
  });
});

describe("points and lists", () => {
  it("finds picked points by id under the Picked pseudo-feature", () => {
    expect(pointExpression(["p1"], "BODY")).toBe(
      'qCreatedBy(makeId("Picked") + "p1", EntityType.BODY)',
    );
    expect(pointExpression(["p1", "p2"], "VERTEX")).toBe(
      'qUnion([qCreatedBy(makeId("Picked") + "p1", EntityType.VERTEX), qCreatedBy(makeId("Picked") + "p2", EntityType.VERTEX)])',
    );
  });

  it("makes ids the server accepts, never twice", () => {
    const ids = new Set(Array.from({ length: 1000 }, newPickId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_]{1,40}$/);
  });

  it("writes items in order, leaving out what they don't set", () => {
    expect(listExpression([])).toBe("[]");
    expect(
      listExpression([
        { point: 'qCreatedBy(makeId("Picked") + "p1", EntityType.BODY)' },
        {},
        { x: "5 * millimeter", z: "-2 * millimeter" },
      ]),
    ).toBe(
      '[{ "point" : qCreatedBy(makeId("Picked") + "p1", EntityType.BODY) }, {}, { "x" : 5 * millimeter, "z" : -2 * millimeter }]',
    );
  });
});
