import type { ModelPoint } from "./featureScriptDialog";

/**
 * A point of a drawn outline: where it is on screen (pixels), in the model (meters), and how far
 * in front of the camera (any unit), which perspective divides by.
 */
export interface ProjectedPoint {
  readonly screen: readonly [number, number];
  readonly world: ModelPoint;
  readonly depth: number;
}

/** One segment of a body's drawn edges. */
export interface ProjectedSegment {
  readonly a: ProjectedPoint;
  readonly b: ProjectedPoint;
  /** The middle of the edge it draws, on its true curve; null when the model has none. */
  readonly exact: ModelPoint | null;
}

/** A body's outline from the GLB: its B-rep edges as drawn, and its vertices. */
export interface ProjectedOutline {
  readonly edges: readonly ProjectedSegment[];
  readonly vertices: readonly ProjectedPoint[];
}

/** The surface a click met, and where it was seen from. */
export interface ClickedSurface {
  /** Where the click met it. */
  readonly point: ModelPoint;
  /** Its unit normal there, on the side the camera sees. */
  readonly normal: ModelPoint;
  /** The camera's position. */
  readonly eye: ModelPoint;
  /** The model length one pixel spans at `point`. */
  readonly worldPerPixel: number;
}

/** How near on screen a click must be to an edge, and to a vertex, to pick it. */
const EDGE_PIXELS = 6;
const VERTEX_PIXELS = 8;
/**
 * How far behind the clicked surface an outline point may be, along the camera's line of sight
 * to it, in pixels' worth of model length at the click: more is an edge or vertex the surface
 * hides, seen through it.
 */
const DEPTH_PIXELS = 12;

const minus = (a: ModelPoint, b: ModelPoint): ModelPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: ModelPoint, b: ModelPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: ModelPoint, b: ModelPoint, t: number): ModelPoint => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * Whether `point` isn't hidden by the clicked surface: not further behind it, along the camera's
 * line of sight to the point, than a few pixels' worth. The surface is taken as flat at the click
 * (its tangent plane), which holds over the few pixels a snap reaches. Measured along the line of
 * sight rather than from the click, so at a grazing angle an edge a pixel from the click on screen
 * and millimeters from it in the model still counts.
 */
function visible(surface: ClickedSurface, point: ModelPoint): boolean {
  const sight = minus(point, surface.eye);
  const toward = dot(sight, surface.normal);
  // Seen edge-on, or from the plane's far side: nothing of the plane is in front of it.
  if (toward >= 0) return true;
  // The fraction of the way to `point` at which the line of sight meets the plane.
  const meets = dot(minus(surface.point, surface.eye), surface.normal) / toward;
  return (1 - meets) * Math.hypot(...sight) <= surface.worldPerPixel * DEPTH_PIXELS;
}

/**
 * Where a click lands on the clicked body's outline, leaving out what the clicked `surface` hides:
 * the nearest of its edges within a few pixels, as the point the click is on (`at`, where to show
 * the pick) and the edge's exact middle (`exact`, to name it by; `at` when the model has none),
 * and the nearest of its vertices within a few more, in model space.
 */
export function snapToOutline(
  outline: ProjectedOutline,
  click: readonly [number, number],
  surface: ClickedSurface,
): {
  readonly edge: { readonly at: ModelPoint; readonly exact: ModelPoint } | null;
  readonly vertex: ModelPoint | null;
} {
  let edge: { at: ModelPoint; exact: ModelPoint; pixels: number } | null = null;
  for (const { a, b, exact } of outline.edges) {
    const [dx, dy] = [b.screen[0] - a.screen[0], b.screen[1] - a.screen[1]];
    const length = dx * dx + dy * dy;
    const t =
      length === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((click[0] - a.screen[0]) * dx + (click[1] - a.screen[1]) * dy) / length),
          );
    const pixels = Math.hypot(a.screen[0] + dx * t - click[0], a.screen[1] + dy * t - click[1]);
    // A fraction of the way on screen is another along the edge under perspective.
    const along = (t * a.depth) / ((1 - t) * b.depth + t * a.depth || 1);
    const point = lerp(a.world, b.world, along);
    if (pixels <= EDGE_PIXELS && (edge === null || pixels < edge.pixels) && visible(surface, point))
      edge = { at: point, exact: exact ?? point, pixels };
  }
  let vertex: { point: ModelPoint; pixels: number } | null = null;
  for (const { screen, world } of outline.vertices) {
    const pixels = Math.hypot(screen[0] - click[0], screen[1] - click[1]);
    if (
      pixels <= VERTEX_PIXELS &&
      (vertex === null || pixels < vertex.pixels) &&
      visible(surface, world)
    )
      vertex = { point: world, pixels };
  }
  return {
    edge: edge ? { at: edge.at, exact: edge.exact } : null,
    vertex: vertex?.point ?? null,
  };
}
