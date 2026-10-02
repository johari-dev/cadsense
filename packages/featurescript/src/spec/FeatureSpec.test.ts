// @effect-diagnostics nodeBuiltinImport:off - reads corpus scripts from disk.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { testRuntime } from "../runtime/testing.ts";
import { equals, formatValue, FsMap, untag, type FsValue } from "../runtime/Value.ts";
import { positionAt } from "../syntax/Source.ts";
import { defaultDefinition, featureSpecs, type FeatureInput } from "./FeatureSpec.ts";

const { runtime, load, call } = testRuntime();
const boltCircleSource = NodeFS.readFileSync(
  new URL("../../corpus/bolt-circle/feature.fs", import.meta.url),
  "utf8",
);

/** The value of FeatureScript `expression` in a module importing std. */
const fs = (expression: string): FsValue => {
  const outcome = call(load("return undefined;", "", expression), "expected");
  if (!("value" in outcome)) throw new Error(`${expression} raised ${formatValue(outcome.thrown)}`);
  return outcome.value;
};
const expectFs = (actual: FsValue, expression: string) => {
  const wanted = fs(expression);
  if (!equals(actual, wanted))
    throw new Error(`Got ${formatValue(actual)}; expected ${expression} = ${formatValue(wanted)}`);
};
const summary = (input: FeatureInput) => ({
  id: input.id,
  label: input.label,
  kind: input.kind,
  maxPicks: input.maxPicks,
  filter: input.filter,
  conditions: input.conditions,
  group: input.group,
});

describe("bolt circle spec", () => {
  const module = runtime.load("corpus/bolt-circle/feature.fs", boltCircleSource);
  const [spec] = featureSpecs(runtime.interpreter, module);

  it("names the feature from its annotation", () => {
    expect(spec).toMatchObject({
      name: "boltCircle",
      typeName: "Bolt circle",
      description: "Cuts evenly spaced holes on a circle",
    });
  });

  it("reads every input with its label, kind and visibility", () => {
    const none = { maxPicks: null, filter: null, conditions: [], group: null };
    expect(spec!.inputs.map(summary)).toEqual([
      {
        ...none,
        id: "face",
        label: "Face",
        kind: "query",
        maxPicks: 1,
        filter: "EntityType.FACE && GeometryType.PLANE",
      },
      { ...none, id: "count", label: "Hole count", kind: "integer" },
      { ...none, id: "circleDiameter", label: "Circle diameter", kind: "length" },
      { ...none, id: "holeDiameter", label: "Hole diameter", kind: "length" },
      { ...none, id: "startAngle", label: "Start angle", kind: "angle" },
      { ...none, id: "throughAll", label: "Through all", kind: "boolean" },
      {
        ...none,
        id: "depth",
        label: "Depth",
        kind: "length",
        conditions: ["!definition.throughAll"],
      },
    ]);
  });

  it("takes defaults and bounds from the bound specs, in millimeters and degrees", () => {
    const byId = new Map(spec!.inputs.map((input) => [input.id, input]));
    expectFs(byId.get("face")!.defaultValue, "qNothing()");
    expectFs(byId.get("count")!.defaultValue, "6");
    expectFs(byId.get("circleDiameter")!.defaultValue, "50 * millimeter");
    expectFs(byId.get("holeDiameter")!.defaultValue, "5 * millimeter");
    expectFs(byId.get("startAngle")!.defaultValue, "0 * degree");
    expectFs(byId.get("throughAll")!.defaultValue, "true");
    expectFs(byId.get("depth")!.defaultValue, "25 * millimeter");
    expectFs(byId.get("count")!.bounds!.min, "2");
    expectFs(byId.get("count")!.bounds!.max, "64");
    expectFs(byId.get("circleDiameter")!.bounds!.min, "1 * millimeter");
  });

  it("runs with its defaults through std's feature wrapper until the first geometry call", () => {
    const run = runtime.runFeature(module, "boltCircle", defaultDefinition(spec!));
    expect(run.fault?.reason).toBe("unsupported-builtin");
    // This runtime has no geometry kernel, so the first geometry call stops the run.
    expect(run.fault?.message).toContain("OpenCascade kernel");
    const userFrame = run.fault!.stack.find(
      (frame) => frame.file === "corpus/bolt-circle/feature.fs",
    )!;
    expect(positionAt(module.file, userFrame.span.start).line).toBe(
      boltCircleSource.split("\n").findIndex((line) => line.includes("evPlane(")) + 1,
    );
  });
});

describe("spec shapes", () => {
  const module = runtime.load(
    "test/shapes.fs",
    `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");

export enum Finish
{
    annotation { "Name" : "Matte" }
    MATTE,
    GLOSS
}

annotation { "Feature Type Name" : "Shapes" }
export const shapes = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Finish", "Default" : "GLOSS" }
        definition.finish is Finish;
        annotation { "Name" : "Label" }
        definition.label is string;
        annotation { "Group Name" : "Advanced" }
        {
            annotation { "Name" : "Scale" }
            isReal(definition.scale, POSITIVE_REAL_BOUNDS);
        }
        annotation { "Name" : "Profiles", "Item name" : "Profile" }
        definition.profiles is array;
        for (var profile in definition.profiles)
        {
            annotation { "Name" : "Width" }
            isLength(profile.width, LENGTH_BOUNDS);
        }
    }
    {
    });
`,
  );
  const [spec] = featureSpecs(runtime.interpreter, module);
  const byId = new Map(spec!.inputs.map((input) => [input.id, input]));

  it("enum inputs default to the annotated member", () => {
    expect(byId.get("finish")!.kind).toBe("enum");
    expect(byId.get("finish")!.enumType?.members).toEqual(["MATTE", "GLOSS"]);
    expect(untag(byId.get("finish")!.defaultValue)).toBe("GLOSS");
  });
  it("strings default to empty", () => expect(byId.get("label")!.defaultValue).toBe(""));
  it("groups carry their name", () =>
    expect(byId.get("scale")).toMatchObject({ kind: "real", group: "Advanced" }));
  it("array inputs list their inner inputs", () => {
    expect(byId.get("profiles")!.kind).toBe("array");
    expect(byId.get("profiles")!.items.map(summary)).toEqual([
      {
        id: "width",
        label: "Width",
        kind: "length",
        maxPicks: null,
        filter: null,
        conditions: [],
        group: null,
      },
    ]);
  });
  it("overrides replace defaults in the definition", () => {
    const definition = defaultDefinition(spec!, FsMap.fromEntries([["label", "hi"]]));
    expect(definition.getField("label")).toBe("hi");
    expect(untag(definition.getField("finish"))).toBe("GLOSS");
  });
});
