import type { Entity } from "../geometry/Model.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import type { Oc } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { untag } from "../runtime/Value.ts";
import { map } from "./args.ts";
import { EdgeWalk, facesAround, isReversed, minus, reversedInFace } from "./edges.ts";
import { kernel, resolve, transient } from "./geometryArgs.ts";
import { stdEnum, stdTagged } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Ends this close (meters) join, like std's `constructPath` default tolerance. */
const JOIN = 1e-8;

interface Piece {
  readonly edge: Entity;
  /** Start and end in the edge's default orientation (the one `evEdgeTangentLine` uses). */
  readonly ends: readonly [Vec3, Vec3];
}
interface Chain {
  readonly pieces: readonly Piece[];
  /** Per piece: traversed against its default orientation. */
  readonly flipped: readonly boolean[];
  readonly closed: boolean;
}

/**
 * Groups edges into chains joined end to end. Chains come in the query order of their earliest
 * edge. A loop starts at its earliest edge, unflipped; an open chain starts at the free end of its
 * earliest end edge. Edges that branch can't form a path.
 */
function chainsOf(call: BuiltinCall, pieces: readonly Piece[]): Chain[] {
  // Join ends into nodes.
  const nodes: Vec3[] = [];
  const nodeOf = (point: Vec3) => {
    const found = nodes.findIndex((node) => Math.hypot(...minus(node, point)) <= JOIN);
    if (found >= 0) return found;
    nodes.push(point);
    return nodes.length - 1;
  };
  const endNodes = pieces.map((piece) => [nodeOf(piece.ends[0]), nodeOf(piece.ends[1])] as const);
  const atNode = new Map<number, number[]>();
  endNodes.forEach((ends, i) => {
    for (const node of ends) atNode.set(node, [...(atNode.get(node) ?? []), i]);
  });
  if ([...atNode.values()].some((users) => users.length > 2))
    return call.fail("constructPaths: the edges branch, so they don't form paths.");

  const used = new Set<number>();
  const chains: Chain[] = [];
  for (let seed = 0; seed < pieces.length; seed++) {
    if (used.has(seed)) continue;
    // The component of `seed`, to find its free ends.
    const component = new Set<number>([seed]);
    for (const queue = [seed]; queue.length; )
      for (const node of endNodes[queue.pop()!]!)
        for (const other of atNode.get(node)!) {
          if (component.has(other)) continue;
          component.add(other);
          queue.push(other);
        }
    const free = [...component].filter((i) =>
      endNodes[i]!.some((node) => atNode.get(node)!.length === 1),
    );
    const first = free.length ? Math.min(...free) : Math.min(...component);
    // Start on the free end of an open chain's first edge; a loop's first edge runs as it is.
    let flip = free.length > 0 && atNode.get(endNodes[first]![0])!.length !== 1;
    const order = [first];
    const flipped = [flip];
    used.add(first);
    let node = endNodes[first]![flip ? 0 : 1];
    for (;;) {
      const next = atNode.get(node)!.find((i) => !used.has(i));
      if (next === undefined) break;
      flip = endNodes[next]![0] !== node;
      order.push(next);
      flipped.push(flip);
      used.add(next);
      node = endNodes[next]![flip ? 0 : 1];
    }
    chains.push({
      pieces: order.map((i) => pieces[i]!),
      flipped,
      closed: free.length === 0,
    });
  }
  return chains;
}

/**
 * The faces on the seed faces' side of a chain: walking an edge, a face is on the left when it
 * uses the edge in the walking direction. Sides are decided per chain, or per run of edges from
 * one body with `perBody`; seeds on both sides fail.
 */
function sideFaces(
  call: BuiltinCall,
  oc: Oc,
  model: ModelContext,
  chain: Chain,
  seeds: ReadonlySet<string>,
  perBody: boolean,
): Entity[] {
  const runs: { left: Entity[]; right: Entity[] }[] = [];
  let lastBody: string | null = null;
  chain.pieces.forEach((piece, i) => {
    const body = model.geometry.entities.get(piece.edge.body)!;
    if (runs.length === 0 || (perBody && body.id !== lastBody)) runs.push({ left: [], right: [] });
    lastBody = body.id;
    const walkReversed = isReversed(piece.edge.shape) !== chain.flipped[i];
    const faceEntities = [...model.geometry.entities.values()].filter(
      (entity) => entity.type === "FACE" && entity.body === body.id,
    );
    for (const face of facesAround(oc, body, piece.edge.shape)) {
      const entity = faceEntities.find((candidate) => candidate.shape.IsSame(face));
      if (!entity) continue;
      const run = runs.at(-1)!;
      (reversedInFace(oc, face, piece.edge.shape) === walkReversed ? run.left : run.right).push(
        entity,
      );
    }
  });
  return runs.flatMap(({ left, right }) => {
    const onLeft = left.some((face) => seeds.has(face.id));
    const onRight = right.some((face) => seeds.has(face.id));
    if (onLeft && onRight)
      return call.fail("constructPaths: adjacent seed faces are on both sides of the path.");
    const side = onLeft ? left : onRight ? right : [];
    return side.filter((face, i) => side.findIndex((other) => other.id === face.id) === i);
  });
}

export const PATH_BUILTINS = {
  /**
   * std's `Path`s from a query of edges: each chain of connected edges, in order, with which ones
   * run backwards, whether it's closed, and (given `seedFaces`) the faces on the seeds' side.
   */
  constructPaths: ([ctx, args], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, args, "definition");
    const pieces = resolve(call, model, oc, definition.getField("edges"))
      .filter((entity) => entity.type === "EDGE")
      .map((edge): Piece => {
        const walk = new EdgeWalk(oc, edge.shape, isReversed(edge.shape));
        return {
          edge,
          ends: [walk.at(walk.parameter(0, false)).point, walk.at(walk.parameter(1, false)).point],
        };
      });
    const seedQuery = definition.getField("seedFaces");
    const seeds =
      seedQuery === undefined
        ? null
        : new Set(resolve(call, model, oc, seedQuery).map((face) => face.id));
    const perBody = untag(definition.getField("onlyCheckFacesPerBody")) === true;
    return chainsOf(call, pieces).map((chain) =>
      stdTagged(call, "path.fs", "Path", [
        ["edges", chain.pieces.map((piece) => transient(call, piece.edge))],
        ["flipped", chain.flipped],
        ["closed", chain.closed],
        [
          "adjacentFaces",
          seeds === null
            ? undefined
            : stdTagged(call, "query.fs", "Query", [
                ["queryType", stdEnum(call, "query.fs", "QueryType", "UNION")],
                [
                  "subqueries",
                  sideFaces(call, oc, model, chain, seeds, perBody).map((face) =>
                    transient(call, face),
                  ),
                ],
              ]),
        ],
      ]),
    );
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
