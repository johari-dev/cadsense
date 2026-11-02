import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag } from "../src/runtime/Value.ts";
import { partStudio, variable } from "./partStudio.ts";

/**
 * `evCollision` (`@evCollisionDetection`) between bodies, end to end.
 *
 * Ways this can fail:
 * - A clash type that disagrees with what Onshape reports for solids (from forum reports: overlap
 *   is INTERFERE, containment touching the boundary is INTERFERE too, strict containment is
 *   TOOL_IN_TARGET / TARGET_IN_TOOL, touching at a face, edge or vertex is ABUT_NO_CLASS, and
 *   separate bodies give no entry at all).
 * - Tool and target swapped in the containment types or in the result's fields.
 * - One entry per body pair lost or duplicated when there are several targets.
 * - Curves that cross reported as anything but EXISTS.
 * - A combination this runtime can't classify (faces, `passOwners`) silently answered.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const box = (name: string, from: readonly number[], to: readonly number[]) =>
  `fCuboid(context, id + "${name}", { "corner1" : vector(${from.join(", ")}) * millimeter, "corner2" : vector(${to.join(", ")}) * millimeter });`;
const body = (name: string) => `qCreatedBy(id + "${name}", EntityType.BODY)`;
/** Each collision as "TYPE tool->target", naming bodies by the feature that made them. */
const collide = (setup: string, tools: string, targets: string) => {
  const run = studio.run([
    {
      body: `${setup}
      const names = { ${["a", "b", "c", "line1", "line2"].map((name) => `(${body(name)}) : "${name}"`).join(", ")} };
      const nameOf = function(query) {
          for (var entry in names)
              if (size(evaluateQuery(context, qIntersection([entry.key, qOwnerBody(query)]))) > 0)
                  return entry.value;
          return "?";
      };
      setVariable(context, "collisions", mapArray(evCollision(context, { "tools" : ${tools}, "targets" : ${targets} }),
          c => (c["type"] as string) ~ " " ~ nameOf(c.tool) ~ "->" ~ nameOf(c.target) ~ " " ~ nameOf(c.toolBody) ~ "->" ~ nameOf(c.targetBody)));`,
    },
  ]);
  const feature = run.features[0]!;
  if (feature.fault) throw new Error(feature.fault.message);
  if (feature.status !== "OK") throw new Error(feature.exceptions.map((e) => e.message).join("; "));
  return (untag(variable(run, "collisions")) as readonly unknown[]).map((c) =>
    String(untag(c as never)),
  );
};

describe("evCollision between solids", () => {
  const a = box("a", [0, 0, 0], [10, 10, 10]);
  it("reports overlap as INTERFERE", () => {
    expect(collide(a + box("b", [5, 5, 5], [15, 15, 15]), body("b"), body("a"))).toEqual([
      "INTERFERE b->a b->a",
    ]);
  });
  it("reports bodies touching at a face, an edge or a vertex as ABUT_NO_CLASS", () => {
    expect(collide(a + box("b", [10, 0, 0], [20, 10, 10]), body("b"), body("a"))).toEqual([
      "ABUT_NO_CLASS b->a b->a",
    ]);
    expect(collide(a + box("b", [10, 10, 0], [20, 20, 10]), body("b"), body("a"))).toEqual([
      "ABUT_NO_CLASS b->a b->a",
    ]);
    expect(collide(a + box("b", [10, 10, 10], [20, 20, 20]), body("b"), body("a"))).toEqual([
      "ABUT_NO_CLASS b->a b->a",
    ]);
  });
  it("reports nothing for separate bodies", () => {
    expect(collide(a + box("b", [20, 0, 0], [30, 10, 10]), body("b"), body("a"))).toEqual([]);
  });
  it("reports strict containment by which side is inside", () => {
    const inner = a + box("b", [2, 2, 2], [4, 4, 4]);
    expect(collide(inner, body("b"), body("a"))).toEqual(["TOOL_IN_TARGET b->a b->a"]);
    expect(collide(inner, body("a"), body("b"))).toEqual(["TARGET_IN_TOOL a->b a->b"]);
  });
  it("reports containment that touches the boundary as INTERFERE", () => {
    expect(collide(a + box("b", [0, 0, 0], [4, 4, 4]), body("b"), body("a"))).toEqual([
      "INTERFERE b->a b->a",
    ]);
  });
  it("reports one entry per clashing pair, in target order", () => {
    const setup = a + box("b", [20, 0, 0], [30, 10, 10]) + box("c", [5, 2, 2], [25, 8, 8]);
    expect(collide(setup, body("c"), `qUnion([${body("b")}, ${body("a")}])`)).toEqual([
      // qUnion keeps its order: b, then a.
      "INTERFERE c->b c->b",
      "INTERFERE c->a c->a",
    ]);
  });
});

describe("evCollision with curves", () => {
  const line = (name: string, from: readonly number[], to: readonly number[]) => `
    const ${name}Sketch = newSketchOnPlane(context, id + "${name}", { "sketchPlane" : plane(vector(0, 0, 5) * millimeter, Z_DIRECTION, X_DIRECTION) });
    skLineSegment(${name}Sketch, "line", { "start" : vector(${from.join(", ")}) * millimeter, "end" : vector(${to.join(", ")}) * millimeter });
    skSolve(${name}Sketch);`;
  const edges = (name: string) => `qCreatedBy(id + "${name}", EntityType.EDGE)`;
  it("reports crossing curves as EXISTS and a curve through a solid as INTERFERE", () => {
    const setup =
      box("a", [0, 0, 0], [10, 10, 10]) +
      line("line1", [-5, 5], [15, 5]) +
      line("line2", [5, -5], [5, 15]);
    expect(collide(setup, edges("line1"), edges("line2"))).toEqual([
      "EXISTS line1->line2 line1->line2",
    ]);
    expect(collide(setup, body("a"), edges("line1"))).toEqual(["INTERFERE a->line1 a->line1"]);
  });
  it("reports a curve inside a solid as contained", () => {
    const setup = box("a", [0, 0, 0], [10, 10, 10]) + line("line1", [2, 5], [8, 5]);
    expect(collide(setup, body("a"), edges("line1"))).toEqual(["TARGET_IN_TOOL a->line1 a->line1"]);
  });
});

describe("evCollision limits", () => {
  it("stops on combinations it can't classify", () => {
    const run = studio.run([
      {
        body: `${box("a", [0, 0, 0], [10, 10, 10])}${box("b", [5, 5, 5], [15, 15, 15])}
        evCollision(context, { "tools" : qCreatedBy(id + "a", EntityType.FACE), "targets" : qCreatedBy(id + "b", EntityType.FACE) });`,
      },
    ]);
    expect(run.features[0]!.fault?.message).toMatch(/evCollision between faces/);
    const owners = studio.run([
      {
        body: `${box("a", [0, 0, 0], [10, 10, 10])}
        evCollision(context, { "tools" : ${body("a")}, "targets" : ${body("a")}, "passOwners" : true });`,
      },
    ]);
    expect(owners.features[0]!.fault?.message).toMatch(/passOwners/);
  });
});
