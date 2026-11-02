import type { FeatureScriptDialogInput, FeatureScriptManipulator } from "@cadsense/contracts";

import type { ModelPoint } from "./featureScriptDialog";

/**
 * A manipulator the panel draws, read from a run's fields (meters and radians, Z up). `shown` is
 * the direction a flip arrow points as it is now.
 */
export type DrawnManipulator = {
  readonly key: string;
  /** The `Manipulator` as an expression, sent back with a change. */
  readonly expression: string;
  /** The `definition` field it changes, which the dialog lights up while it's dragged. */
  readonly primaryParameterId: string | null;
} & (
  | {
      readonly type: "LINEAR_1D";
      readonly base: ModelPoint;
      readonly direction: ModelPoint;
      readonly offset: number;
      readonly min: number;
      readonly max: number;
    }
  | { readonly type: "LINEAR_3D"; readonly base: ModelPoint; readonly offset: ModelPoint }
  | {
      readonly type: "ANGULAR";
      readonly axisOrigin: ModelPoint;
      readonly axisDirection: ModelPoint;
      /** Where the handle is at angle zero. */
      readonly rotationOrigin: ModelPoint;
      readonly angle: number;
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly type: "FLIP";
      readonly base: ModelPoint;
      readonly direction: ModelPoint;
      readonly flipped: boolean;
      readonly shown: ModelPoint;
    }
);

/**
 * What of a manipulator a drag takes: a linear arrow, one triad axis or the triad's middle (moved
 * in the plane facing the camera), an angular arc's handle, or a flip arrow (a click).
 */
export type HandlePart = "axis" | "x" | "y" | "z" | "center" | "arc" | "flip";

/** A pointer's ray into the model, `direction` of unit length. */
export interface Ray {
  readonly origin: ModelPoint;
  readonly direction: ModelPoint;
}

const plus = (a: ModelPoint, b: ModelPoint): ModelPoint => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const minus = (a: ModelPoint, b: ModelPoint): ModelPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const times = (a: ModelPoint, k: number): ModelPoint => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: ModelPoint, b: ModelPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ModelPoint, b: ModelPoint): ModelPoint => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: ModelPoint) => Math.hypot(...a);
const unit = (a: ModelPoint): ModelPoint | null => {
  const n = length(a);
  return n > 1e-12 ? times(a, 1 / n) : null;
};
/** `point` with its part along unit `axis` taken out. */
const across = (point: ModelPoint, axis: ModelPoint) => minus(point, times(axis, dot(point, axis)));

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const satisfies Record<
  string,
  ModelPoint
>;
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

const vector = (value: unknown): ModelPoint | null =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((n: unknown) => typeof n === "number" && Number.isFinite(n))
    ? [value[0], value[1], value[2]]
    : null;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The manipulator as the panel draws it, or null for one it can't: no expression to send back,
 * a type it doesn't draw (points, toggle points, full triads), or a field std would have
 * rejected (a zero direction, an arc whose handle is on its axis).
 */
export function readManipulator(manipulator: FeatureScriptManipulator): DrawnManipulator | null {
  const { key, expression, fields } = manipulator;
  if (expression === null) return null;
  const primary = fields.primaryParameterId;
  const common = {
    key,
    expression,
    primaryParameterId: typeof primary === "string" ? primary : null,
  };
  switch (manipulator.type) {
    case "LINEAR_1D": {
      const base = vector(fields.base);
      const direction = unit(vector(fields.direction) ?? [0, 0, 0]);
      const offset = finite(fields.offset);
      if (!base || !direction || offset === null) return null;
      return {
        ...common,
        type: "LINEAR_1D",
        base,
        direction,
        offset,
        // std's defaults.
        min: finite(fields.minValue) ?? -500,
        max: finite(fields.maxValue) ?? 500,
      };
    }
    case "LINEAR_3D": {
      const base = vector(fields.base);
      const offset = vector(fields.offset);
      return base && offset ? { ...common, type: "LINEAR_3D", base, offset } : null;
    }
    case "ANGULAR": {
      const axisOrigin = vector(fields.axisOrigin);
      const axisDirection = unit(vector(fields.axisDirection) ?? [0, 0, 0]);
      const rotationOrigin = vector(fields.rotationOrigin);
      const angle = finite(fields.angle);
      if (!axisOrigin || !axisDirection || !rotationOrigin || angle === null) return null;
      // The arc needs a radius: the handle off the axis.
      if (!unit(across(minus(rotationOrigin, axisOrigin), axisDirection))) return null;
      return {
        ...common,
        type: "ANGULAR",
        axisOrigin,
        axisDirection,
        rotationOrigin,
        angle,
        min: finite(fields.minValue) ?? -Math.PI,
        max: finite(fields.maxValue) ?? Math.PI,
      };
    }
    case "FLIP": {
      const base = vector(fields.base);
      const direction = unit(vector(fields.direction) ?? [0, 0, 0]);
      const flipped = fields.flipped;
      if (!base || !direction || typeof flipped !== "boolean") return null;
      const other = unit(vector(fields.otherDirection) ?? [0, 0, 0]);
      return {
        ...common,
        type: "FLIP",
        base,
        direction,
        flipped,
        shown: flipped ? (other ?? minus([0, 0, 0], direction)) : direction,
      };
    }
    default:
      return null;
  }
}

/** Where a drawn manipulator's handle is: an arrow's tip, a triad's middle, an arc's end. */
export function handlePoint(manipulator: DrawnManipulator): ModelPoint {
  switch (manipulator.type) {
    case "LINEAR_1D":
      return plus(manipulator.base, times(manipulator.direction, manipulator.offset));
    case "LINEAR_3D":
      return plus(manipulator.base, manipulator.offset);
    case "ANGULAR":
      return arcPoint(manipulator, manipulator.angle);
    case "FLIP":
      return manipulator.base;
  }
}

/** Where an angular manipulator's handle is at `angle`: its zero point turned about its axis. */
export function arcPoint(
  manipulator: Extract<DrawnManipulator, { type: "ANGULAR" }>,
  angle: number,
): ModelPoint {
  const { axisOrigin, axisDirection } = manipulator;
  const arm = minus(manipulator.rotationOrigin, axisOrigin);
  const along = times(axisDirection, dot(arm, axisDirection));
  const radial = minus(arm, along);
  // Rodrigues' rotation of the radial part; the part along the axis stays.
  const turned = plus(
    times(radial, Math.cos(angle)),
    times(cross(axisDirection, radial), Math.sin(angle)),
  );
  return plus(plus(axisOrigin, along), turned);
}

/** Below this sine between the ray and an axis, the ray runs along it and gives no position. */
const ALONG_SINE = 0.02;

/**
 * How far along the line through `origin` in unit `direction` its nearest point to `ray` is, or
 * null when the ray runs (nearly) along the line, where any point is as near and the value would
 * jump.
 */
export function alongAxis(ray: Ray, origin: ModelPoint, direction: ModelPoint): number | null {
  const b = dot(ray.direction, direction);
  const denominator = 1 - b * b;
  if (denominator < ALONG_SINE * ALONG_SINE) return null;
  const w = minus(origin, ray.origin);
  return (b * dot(w, ray.direction) - dot(w, direction)) / denominator;
}

/**
 * Where `ray` meets the plane through `origin` with unit `normal`, or null when it runs parallel
 * to it or meets it behind the camera.
 */
export function onPlane(ray: Ray, origin: ModelPoint, normal: ModelPoint): ModelPoint | null {
  const toward = dot(ray.direction, normal);
  if (Math.abs(toward) < 1e-6) return null;
  const t = dot(minus(origin, ray.origin), normal) / toward;
  return t > 0 ? plus(ray.origin, times(ray.direction, t)) : null;
}

/**
 * The angle of `point` about the axis through `origin` in unit `axis`, from `zero` (a direction
 * across it), right-handed, in (-π, π]; null for a point on the axis.
 */
export function angleAbout(
  point: ModelPoint,
  origin: ModelPoint,
  axis: ModelPoint,
  zero: ModelPoint,
): number | null {
  const radial = unit(across(minus(point, origin), axis));
  const start = unit(across(zero, axis));
  if (!radial || !start) return null;
  return Math.atan2(dot(cross(start, radial), axis), dot(start, radial));
}

/** The step drags round lengths to: the smallest power of ten (in meters) one pixel spans. */
export const dragStep = (worldPerPixel: number) =>
  10 ** Math.ceil(Math.log10(Math.max(worldPerPixel, 1e-9)) - 1e-9);

const round = (value: number, step: number) => Math.round(value / step) * step;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const ANGLE_STEP = Math.PI / 180;

const millimeters = (meters: number) => String(+(meters * 1000).toFixed(4));
const degrees = (radians: number) => String(+((radians * 180) / Math.PI).toFixed(4));
const shownMm = (meters: number) => `${+(meters * 1000).toFixed(2)} mm`;

/** A drag in progress: the manipulator, the part grabbed, and what the grab measured. */
export interface Drag {
  readonly manipulator: DrawnManipulator;
  readonly part: HandlePart;
  /** Where the grab met the handle's axis or plane, to move by how far the pointer moved. */
  readonly grab: number | ModelPoint;
  /** The dialog row's label, for what the handle shows; null names it by its field. */
  readonly name: string | null;
  /**
   * For an arc: the pointer's last angle and the turn so far, unwrapped, so a drag past half a
   * turn goes on. Each move updates it.
   */
  turned: { raw: number; total: number } | null;
}

/** Where a drag has the manipulator now, and what to send and show for it. */
export interface DragValue {
  /** The new offset (a length or the triad's vector), angle, or flip. */
  readonly value: number | ModelPoint | boolean;
  /** Where the handle is now. */
  readonly at: ModelPoint;
  /** The manipulator's changed fields as expressions, for `manipulatorChange`. */
  readonly changes: Readonly<Record<string, string>>;
  /** What the handle shows, e.g. `Z offset 40 mm`. */
  readonly label: string;
}

/** The plane a triad's middle moves in: through it, facing back along the grab's ray. */
const facing = (ray: Ray) => times(ray.direction, -1);

/**
 * Starts dragging `part` of `manipulator` from where `ray` grabbed it, for the dialog row named
 * `name` (see {@link manipulatorRow}); null if the ray gives no position to start from.
 */
export function startDrag(
  manipulator: DrawnManipulator,
  part: HandlePart,
  ray: Ray,
  name: string | null = null,
): Drag | null {
  const at = handlePoint(manipulator);
  const drag = (grab: number | ModelPoint, turned: Drag["turned"] = null): Drag => ({
    manipulator,
    part,
    grab,
    name,
    turned,
  });
  switch (manipulator.type) {
    case "LINEAR_1D": {
      const t = alongAxis(ray, manipulator.base, manipulator.direction);
      return t === null ? null : drag(t - manipulator.offset);
    }
    case "LINEAR_3D": {
      if (part === "center") {
        const hit = onPlane(ray, at, facing(ray));
        return hit ? drag(hit) : null;
      }
      if (part !== "x" && part !== "y" && part !== "z") return null;
      const t = alongAxis(ray, at, AXES[part]);
      return t === null ? null : drag(t);
    }
    case "ANGULAR": {
      const hit = onPlane(ray, manipulator.axisOrigin, manipulator.axisDirection);
      const raw = hit ? angleOf(manipulator, hit) : null;
      return raw === null ? null : drag(raw, { raw, total: 0 });
    }
    case "FLIP":
      return drag(0);
  }
}

const angleOf = (manipulator: Extract<DrawnManipulator, { type: "ANGULAR" }>, point: ModelPoint) =>
  angleAbout(
    point,
    manipulator.axisOrigin,
    manipulator.axisDirection,
    minus(manipulator.rotationOrigin, manipulator.axisOrigin),
  );

/**
 * Where `drag` has its manipulator with the pointer on `ray`: lengths rounded to what a pixel shows
 * at `worldPerPixel`, angles to whole degrees, both within the manipulator's bounds. Null when the
 * ray gives no position (it runs along the axis, or misses the plane); the handle stays put.
 */
export function dragManipulator(
  drag: Drag,
  ray: Ray,
  view: { readonly worldPerPixel: number },
): DragValue | null {
  const { manipulator } = drag;
  const step = dragStep(view.worldPerPixel);
  switch (manipulator.type) {
    case "LINEAR_1D": {
      const t = alongAxis(ray, manipulator.base, manipulator.direction);
      if (t === null || typeof drag.grab !== "number") return null;
      const offset = clamp(round(t - drag.grab, step), manipulator.min, manipulator.max);
      return {
        value: offset,
        at: plus(manipulator.base, times(manipulator.direction, offset)),
        changes: { offset: `${millimeters(offset)} * millimeter` },
        label: `${drag.name ?? "Offset"} ${shownMm(offset)}`,
      };
    }
    case "LINEAR_3D": {
      const start = handlePoint(manipulator);
      let offset: ModelPoint;
      let label: string;
      if (drag.part === "center") {
        const hit = onPlane(ray, start, facing(ray));
        if (!hit || typeof drag.grab === "number") return null;
        const moved = plus(manipulator.offset, minus(hit, drag.grab));
        offset = [round(moved[0], step), round(moved[1], step), round(moved[2], step)];
        label = `Offset (${offset.map((n) => +(n * 1000).toFixed(2)).join(", ")}) mm`;
      } else {
        if (drag.part !== "x" && drag.part !== "y" && drag.part !== "z") return null;
        const t = alongAxis(ray, start, AXES[drag.part]);
        if (t === null || typeof drag.grab !== "number") return null;
        const index = AXIS_INDEX[drag.part];
        const component = round(manipulator.offset[index] + t - drag.grab, step);
        offset = [
          index === 0 ? component : manipulator.offset[0],
          index === 1 ? component : manipulator.offset[1],
          index === 2 ? component : manipulator.offset[2],
        ];
        label = `${drag.part.toUpperCase()} offset ${shownMm(component)}`;
      }
      return {
        value: offset,
        at: plus(manipulator.base, offset),
        changes: { offset: `vector(${offset.map(millimeters).join(", ")}) * millimeter` },
        label,
      };
    }
    case "ANGULAR": {
      const hit = onPlane(ray, manipulator.axisOrigin, manipulator.axisDirection);
      const raw = hit ? angleOf(manipulator, hit) : null;
      if (raw === null || drag.turned === null) return null;
      // The smallest turn from the last angle, so +179 to -179 degrees is two more, not 358 back.
      const turn = raw - drag.turned.raw;
      const total = drag.turned.total + turn - 2 * Math.PI * Math.round(turn / (2 * Math.PI));
      drag.turned = { raw, total };
      const angle = clamp(
        round(manipulator.angle + total, ANGLE_STEP),
        manipulator.min,
        manipulator.max,
      );
      return {
        value: angle,
        at: arcPoint(manipulator, angle),
        changes: { angle: `${degrees(angle)} * degree` },
        label: `${drag.name ?? "Angle"} ${+((angle * 180) / Math.PI).toFixed(1)} deg`,
      };
    }
    case "FLIP":
      return {
        value: !manipulator.flipped,
        at: manipulator.base,
        changes: { flipped: String(!manipulator.flipped) },
        label: manipulator.flipped ? "Unflip" : "Flip",
      };
  }
}

/**
 * The dialog row a manipulator drives, lit while it's dragged: the input its `primaryParameterId`
 * names, or else the list item its key numbers (`waypoint1` is the second item of the list whose
 * items are named "Waypoint", counting from zero as a feature's loop does). `item` is the item's
 * key, or null when the list ran as one expression. Null when neither is shown.
 */
export function manipulatorRow(
  manipulator: DrawnManipulator,
  inputs: readonly FeatureScriptDialogInput[],
  listKeys: Readonly<Record<string, readonly string[]>>,
):
  | { readonly input: string; readonly name: string }
  | {
      readonly list: string;
      readonly index: number;
      readonly item: string | null;
      readonly name: string;
    }
  | null {
  const visible = inputs.filter((input) => input.visible);
  const primary = visible.find((input) => input.id === manipulator.primaryParameterId);
  if (primary) return { input: primary.id, name: primary.label };
  const numbered = /^(.*?)[\s_-]*(\d+)$/.exec(manipulator.key);
  if (!numbered) return null;
  const prefix = numbered[1]!.toLowerCase();
  const index = Number(numbered[2]);
  const list = visible.find(
    (input) =>
      input.kind === "array" &&
      [
        input.itemName?.toLowerCase(),
        input.id.toLowerCase(),
        input.id.toLowerCase().replace(/s$/, ""),
      ].includes(prefix),
  );
  if (!list || index >= list.items.length) return null;
  return {
    list: list.id,
    index,
    item: listKeys[list.id]?.[index] ?? null,
    name: `${list.itemName ?? "Item"} ${index + 1}`,
  };
}
