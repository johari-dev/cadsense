import { describe, expect, it } from "vite-plus/test";
import { inputExpression, pickExpression } from "./featureScriptDialog";

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
  it("finds the base face nearest a picked point, given in meters, as millimeters", () => {
    expect(pickExpression([[0.05, 0.03, 0.01]])).toBe(
      'qClosestTo(qCreatedBy(makeId("Base"), EntityType.FACE), vector(50, 30, 10) * millimeter)',
    );
    expect(pickExpression([[0.0123456789, -0.0000000001, 0.1]])).toBe(
      'qClosestTo(qCreatedBy(makeId("Base"), EntityType.FACE), vector(12.3457, 0, 100) * millimeter)',
    );
  });

  it("combines several picks into one query", () => {
    expect(
      pickExpression([
        [0, 0, 0.01],
        [0.1, 0, 0.005],
      ]),
    ).toBe(
      'qUnion([qClosestTo(qCreatedBy(makeId("Base"), EntityType.FACE), vector(0, 0, 10) * millimeter), qClosestTo(qCreatedBy(makeId("Base"), EntityType.FACE), vector(100, 0, 5) * millimeter)])',
    );
  });
});
