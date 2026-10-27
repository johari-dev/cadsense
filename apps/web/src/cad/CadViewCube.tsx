// The viewport's orientation cube, as in Onshape, Fusion, and SolidWorks. It turns with the live
// camera, and clicking a face, edge, or corner snaps the camera to look along that direction.
// Drawn with CSS 3D transforms, so it needs no second WebGL context.
import type { CadViewState } from "@cadsense/contracts";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { CubeIcon } from "~/lib/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import { CAD_VIEW_DIRECTIONS, cadPresetUp } from "./CadSceneModel";

type Vec = readonly [number, number, number];
type Preset = Extract<CadViewState["camera"], { kind: "preset" }>["preset"];

/** Cube edge in px. The isometric silhouette is about 1.6 times this. */
const EDGE = 46;
/** Share of a face edge each edge and corner zone takes. */
const RIM = 0.24;

/**
 * Each face: the preset it applies, with its outward normal and label up taken from the preset's
 * eye direction and camera up, so a face's label reads upright when its preset is applied.
 */
const FACES = (
  [
    { preset: "front", label: "Front", tint: 4 },
    { preset: "back", label: "Back", tint: 4 },
    { preset: "left", label: "Left", tint: 0 },
    { preset: "right", label: "Right", tint: 0 },
    { preset: "top", label: "Top", tint: 8 },
    { preset: "bottom", label: "Bottom", tint: 0 },
  ] as const satisfies ReadonlyArray<{
    preset: Exclude<Preset, "isometric">;
    label: string;
    /** Percent of foreground mixed into the face, a fixed light from above so edges read. */
    tint: number;
  }>
).map((face) => ({
  ...face,
  normal: CAD_VIEW_DIRECTIONS[face.preset] as Vec,
  up: cadPresetUp(face.preset) as Vec,
}));
/** The isometric preset looks from the front, right, top corner. */
const ISOMETRIC: Vec = CAD_VIEW_DIRECTIONS.isometric;

const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v: Vec): Vec => {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};
const same = (a: Vec, b: Vec) => {
  const [x, y] = [normalize(a), normalize(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 1e-6;
};

/**
 * CSS transform that shows world space as the camera sees it. CSS axes run right, down, and
 * toward the viewer, so world vectors map to (along right, minus along up, minus along forward).
 */
function cubeTransform(pose: { position: Vec; target: Vec; up: Vec }) {
  const forward = normalize([
    pose.target[0] - pose.position[0],
    pose.target[1] - pose.position[1],
    pose.target[2] - pose.position[2],
  ]);
  const right = normalize(cross(forward, pose.up));
  const up = cross(right, forward);
  const columns = [0, 1, 2].map((axis) => [right[axis]!, -up[axis]!, -forward[axis]!, 0].join(","));
  return `matrix3d(${columns.join(",")},0,0,0,1)`;
}

/** Places a face div in world space: text right, text down, outward normal, then out by half. */
function faceTransform(normal: Vec, up: Vec) {
  const right = cross(up, normal);
  const half = EDGE / 2;
  return `matrix3d(${[
    ...right,
    0,
    ...up.map((value) => -value),
    0,
    ...normal,
    0,
    ...normal.map((value) => value * half),
    1,
  ].join(",")})`;
}

/** The camera a click applies: a preset when the direction is one, else a fitted free pose. */
function cameraFor(direction: Vec, projection: "perspective" | "orthographic") {
  const face = FACES.find((candidate) => same(candidate.normal, direction));
  const preset: Preset | undefined = same(direction, ISOMETRIC) ? "isometric" : face?.preset;
  if (preset) return { kind: "preset" as const, preset, fit: [] };
  // Edges and corners other than the isometric one. A pose with `fit` keeps its direction and
  // frames the shown parts, so the position and target here only set that direction.
  return {
    kind: "pose" as const,
    pose: {
      position: normalize(direction),
      target: [0, 0, 0] as Vec,
      up: [0, 0, 1] as Vec,
      projection,
      zoom: 1,
    },
    fit: [],
  };
}

/** The camera `view` stores, for when no renderer is attached to follow. */
function storedPose(view: CadViewState) {
  if (view.camera.kind === "pose") return view.camera.pose;
  const preset = view.camera.preset;
  const face = FACES.find((candidate) => candidate.preset === preset);
  const direction = face?.normal ?? ISOMETRIC;
  return { position: direction, target: [0, 0, 0] as Vec, up: face?.up ?? ([0, 0, 1] as Vec) };
}

export function CadViewCube({
  renderer,
  view,
  disabled,
  onChange,
}: {
  renderer: RefObject<CadSceneRenderer | null> | undefined;
  view: CadViewState;
  disabled: boolean;
  onChange: (view: CadViewState) => void;
}) {
  const cube = useRef<HTMLDivElement>(null);
  // Follows the renderer's frames, coalesced in a microtask like the comment markers, so a
  // still camera costs nothing and the cube never lags the model by a frame.
  useLayoutEffect(() => {
    const node = cube.current;
    const current = renderer?.current;
    if (!node) return;
    const draw = () => {
      node.style.transform = cubeTransform(current?.cameraPose() ?? storedPose(view));
    };
    draw();
    if (!current) return;
    let queued = false;
    let active = true;
    const unsubscribe = current.subscribeFrames(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) draw();
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [renderer, view]);
  const snap = (direction: Vec) => {
    if (disabled) return;
    const projection = renderer?.current?.cameraPose().projection ?? "perspective";
    onChange({ ...view, camera: cameraFor(direction, projection) });
  };
  const zones = [-1, 0, 1].flatMap((row) => [-1, 0, 1].map((column) => ({ row, column })));
  const size = (index: number) => (index === 0 ? `${100 - 200 * RIM}%` : `${100 * RIM}%`);
  return (
    <div
      role="group"
      aria-label="View cube"
      className="pointer-events-auto relative flex size-[84px] items-center justify-center"
    >
      <div
        ref={cube}
        className="relative [transform-style:preserve-3d]"
        style={{ width: EDGE, height: EDGE }}
      >
        {FACES.map((face) => {
          const right = cross(face.up, face.normal);
          return (
            <div
              key={face.preset}
              className="absolute inset-0 grid [backface-visibility:hidden] rounded-[3px] border border-foreground/15 transition-colors has-[>button:hover]:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_16%)]! has-[>button:focus-visible]:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_16%)]!"
              style={{
                transform: faceTransform(face.normal, face.up),
                background: `color-mix(in srgb, var(--popover), var(--foreground) ${face.tint}%)`,
                gridTemplateColumns: [-1, 0, 1].map(size).join(" "),
                gridTemplateRows: [-1, 0, 1].map(size).join(" "),
              }}
            >
              {zones.map(({ row, column }) => {
                // Rows run top to bottom on the face, so the top row leans toward `up`.
                const toward = (axis: 0 | 1 | 2) =>
                  face.normal[axis] + column * right[axis] - row * face.up[axis];
                const direction: Vec = [toward(0), toward(1), toward(2)];
                if (row === 0 && column === 0)
                  return (
                    <Tooltip key="face">
                      <TooltipTrigger
                        aria-label={`${face.label} view`}
                        disabled={disabled}
                        className="flex cursor-pointer items-center justify-center text-[8px] font-semibold tracking-wider text-muted-foreground uppercase outline-none transition-colors hover:text-foreground focus-visible:text-foreground disabled:cursor-default"
                        onClick={() => snap(face.normal)}
                      >
                        {face.label}
                      </TooltipTrigger>
                      <TooltipPopup>{`${face.label} view`}</TooltipPopup>
                    </Tooltip>
                  );
                // Edge and corner zones are pointer shortcuts; the face buttons and the home
                // button cover every view a keyboard needs.
                return (
                  <div
                    key={`${row}${column}`}
                    aria-hidden="true"
                    className={
                      disabled
                        ? undefined
                        : "cursor-pointer transition-colors hover:bg-foreground/12"
                    }
                    onClick={() => snap(direction)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <Tooltip>
        <TooltipTrigger
          aria-label="Isometric view"
          disabled={disabled}
          className="absolute top-0 right-0 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
          onClick={() => snap(ISOMETRIC)}
        >
          <CubeIcon aria-hidden="true" className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>Isometric view</TooltipPopup>
      </Tooltip>
    </div>
  );
}
