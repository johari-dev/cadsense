import { beforeAll, describe, expect, it } from "vite-plus/test";
import { untag } from "../src/runtime/Value.ts";
import { numberVariable, partStudio, variable } from "./partStudio.ts";

/**
 * `constructPaths` (`@constructPaths`), end to end through std's wrapper.
 *
 * Ways it can fail:
 * - Edges given out of order come back in query order, not end to end, or with `flipped` wrong, so
 *   one edge's end isn't the next one's start.
 * - A loop isn't marked closed, or an open chain is.
 * - Separate chains merge into one path, or one chain splits.
 * - Branching edges silently make a path.
 * - `adjacentFaces` takes faces from the wrong side, or seeds on both sides pass.
 */
let studio: Awaited<ReturnType<typeof partStudio>>;
beforeAll(async () => {
  studio = await partStudio();
});

const cube =
  'fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';
const edge = (x: number, y: number, z: number) =>
  `qContainsPoint(qCreatedBy(id, EntityType.EDGE), vector(${x}, ${y}, ${z}) * millimeter)`;
const face = (x: number, y: number, z: number) =>
  `qContainsPoint(qCreatedBy(id, EntityType.FACE), vector(${x}, ${y}, ${z}) * millimeter)`;
// The top loop's edges, listed out of order.
const topLoop = [edge(5, 0, 10), edge(5, 10, 10), edge(0, 5, 10), edge(10, 5, 10)];

/** Records each path's size, closed flag, and how far each edge's end is from the next one's start. */
const describePaths = (paths: string) => `
  const paths = ${paths};
  setVariable(context, "count", size(paths));
  setVariable(context, "sizes", mapArray(paths, path => size(path.edges)));
  setVariable(context, "closed", mapArray(paths, path => path.closed));
  setVariable(context, "gaps", mapArray(paths, function(path) {
      var gaps = [];
      const n = size(path.edges);
      for (var i = 0; i < n - (path.closed ? 0 : 1); i += 1)
          gaps = append(gaps, norm(edgeEndTangentLine(context, path, i, true).origin - edgeEndTangentLine(context, path, (i + 1) % n, false).origin) / millimeter);
      return gaps;
  }));`;
const run = (body: string) => {
  const result = studio.run([{ body }]);
  const feature = result.features[0]!;
  if (feature.fault) throw new Error(feature.fault.message);
  if (feature.status !== "OK") throw new Error(feature.exceptions.map((e) => e.message).join("; "));
  return result;
};
const list = (result: ReturnType<typeof run>, name: string) =>
  (untag(variable(result, name)) as readonly unknown[]).map((value) => untag(value as never));

describe("constructPaths", () => {
  it("orders a loop given out of order end to end, and keeps a separate edge its own path", () => {
    const result = run(
      `${cube}${describePaths(`constructPaths(context, qUnion([${[...topLoop, edge(5, 0, 0)].join(", ")}]), {})`)}`,
    );
    expect(numberVariable(result, "count")).toBe(2);
    // Path order follows the edges' query order; compare by size.
    const closedBySize = list(result, "sizes").map((size, i) => [size, list(result, "closed")[i]]);
    expect(closedBySize.toSorted((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, false],
      [4, true],
    ]);
    for (const gaps of list(result, "gaps") as unknown as (readonly unknown[])[])
      for (const gap of gaps) expect(untag(gap as never) as number).toBeCloseTo(0, 9);
  });

  it("makes an open chain from one end to the other", () => {
    const result = run(
      `${cube}${describePaths(`constructPaths(context, qUnion([${topLoop.slice(0, 3).join(", ")}]), {})`)}
      setVariable(context, "ends", mapArray(paths, path => [edgeEndTangentLine(context, path, 0, false).origin[0] / millimeter, edgeEndTangentLine(context, path, 2, true).origin[0] / millimeter]));`,
    );
    expect(list(result, "sizes")).toEqual([3]);
    expect(list(result, "closed")).toEqual([false]);
    // The chain y=0 -> x=0 -> y=10 runs from x = 10 to x = 10, one end on each open edge.
    const [ends] = list(result, "ends") as unknown as (readonly unknown[])[];
    expect((ends ?? []).map((x) => untag(x as never) as number).map((x) => Math.round(x))).toEqual([
      10, 10,
    ]);
    for (const gaps of list(result, "gaps") as unknown as (readonly unknown[])[])
      for (const gap of gaps) expect(untag(gap as never) as number).toBeCloseTo(0, 9);
  });

  it("refuses edges that branch", () => {
    const result = run(`${cube}
      var caught;
      try silent { constructPaths(context, qUnion([${edge(5, 0, 10)}, ${edge(0, 5, 10)}, ${edge(0, 0, 5)}]), {}); }
      catch (error) { caught = true; }
      setVariable(context, "caught", caught);`);
    expect(variable(result, "caught")).toBe(true);
  });

  it("collects the faces on the seed faces' side, and refuses seeds on both sides", () => {
    const loop = `qUnion([${topLoop.join(", ")}])`;
    const result = run(`${cube}
      const top = constructPaths(context, ${loop}, { "adjacentSeedFaces" : ${face(5, 5, 10)} });
      setVariable(context, "topSide", size(evaluateQuery(context, top[0].adjacentFaces)));
      setVariable(context, "topIsTop", size(evaluateQuery(context, qSubtraction(top[0].adjacentFaces, ${face(5, 5, 10)}))));
      const sides = constructPaths(context, ${loop}, { "adjacentSeedFaces" : ${face(5, 0, 5)} });
      setVariable(context, "sideCount", size(evaluateQuery(context, sides[0].adjacentFaces)));
      setVariable(context, "sidesHaveTop", size(evaluateQuery(context, qIntersection([sides[0].adjacentFaces, ${face(5, 5, 10)}]))));
      var caught;
      try silent { constructPaths(context, ${loop}, { "adjacentSeedFaces" : qUnion([${face(5, 5, 10)}, ${face(5, 0, 5)}]) }); }
      catch (error) { caught = true; }
      setVariable(context, "bothSides", caught);`);
    expect(numberVariable(result, "topSide")).toBe(1);
    expect(numberVariable(result, "topIsTop")).toBe(0);
    expect(numberVariable(result, "sideCount")).toBe(4);
    expect(numberVariable(result, "sidesHaveTop")).toBe(0);
    expect(variable(result, "bothSides")).toBe(true);
  });
});
