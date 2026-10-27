// The viewport's orientation cube, as in Onshape, Fusion, and SolidWorks. It turns with the live
// camera, and clicking a face, edge, or corner snaps the camera to look along that direction.
// Drawn with CSS 3D transforms, so it needs no second WebGL context.
import type { CadViewState } from "@cadsense/contracts";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { HouseIcon } from "~/lib/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import { CAD_VIEW_DIRECTIONS, cadPresetUp } from "./CadSceneModel";

type Vec = readonly [number, number, number];
type Preset = Extract<CadViewState["camera"], { kind: "preset" }>["preset"];

/** Cube edge in px, wide enough for a 10px "FRONT" or "RIGHT". */
const EDGE = 40;
/** The cube's box: its space diagonal, the widest it can project at any angle. */
const BOX = Math.ceil(EDGE * Math.sqrt(3));
/** Face fill. The class names carry the #6b6b6b edge line and the hover tint, the scene's
    selection blue #7dbbff (as in CadCommentsCard). */
const FACE = "#2a2a2a";
/** Share of a face edge each edge and corner zone takes. */
const RIM = 0.2;

/**
 * Each face: the preset it applies, with its outward normal and label up taken from the preset's
 * eye direction and camera up, so a face's label reads upright when its preset is applied.
 */
const FACES = (
  [
    { preset: "front", label: "Front", tag: "Front", shade: 4 },
    { preset: "back", label: "Back", tag: "Back", shade: 4 },
    { preset: "left", label: "Left", tag: "Left", shade: 0 },
    { preset: "right", label: "Right", tag: "Right", shade: 0 },
    { preset: "top", label: "Top", tag: "Top", shade: 10 },
    { preset: "bottom", label: "Bottom", tag: "Btm", shade: -30 },
  ] as const satisfies ReadonlyArray<{
    preset: Exclude<Preset, "isometric">;
    label: string;
    /** The text on the face, short enough to fit it at 10px. */
    tag: string;
    /** A fixed light from above: percent of white mixed into the face, or of black when
        negative. A face seen nearly edge-on still reads as a lit top or a dark underside. */
    shade: number;
  }>
).map((face) => ({
  ...face,
  normal: CAD_VIEW_DIRECTIONS[face.preset],
  up: cadPresetUp(face.preset),
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

/** The camera's right, up, and forward directions in world space. */
function cameraBasis(pose: { position: Vec; target: Vec; up: Vec }) {
  const forward = normalize([
    pose.target[0] - pose.position[0],
    pose.target[1] - pose.position[1],
    pose.target[2] - pose.position[2],
  ]);
  const right = normalize(cross(forward, pose.up));
  return { right, up: cross(right, forward), forward };
}

/**
 * CSS transform that shows world space as the camera sees it. CSS axes run right, down, and
 * toward the viewer, so world vectors map to (along right, minus along up, minus along forward).
 */
function cubeTransform({ right, up, forward }: ReturnType<typeof cameraBasis>) {
  const columns = ([0, 1, 2] as const).map((axis) =>
    [right[axis], -up[axis], -forward[axis], 0].join(","),
  );
  return `matrix3d(${columns.join(",")},0,0,0,1)`;
}

/** Label opacity for a face: full when it faces the camera, gone before it turns edge-on, where
    the squeezed text would read as noise. */
const labelOpacity = (normal: Vec, forward: Vec) => {
  const facing = -(normal[0] * forward[0] + normal[1] * forward[1] + normal[2] * forward[2]);
  return String(Math.min(1, Math.max(0, (facing - 0.2) / 0.3)));
};

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
  const home = useRef<HTMLButtonElement>(null);
  const labels = useRef<Array<HTMLSpanElement | null>>([]);
  // Follows the renderer's frames, coalesced in a microtask like the comment markers, so a
  // still camera costs nothing and the cube never lags the model by a frame.
  useLayoutEffect(() => {
    const node = cube.current;
    const current = renderer?.current;
    if (!node) return;
    const draw = () => {
      const basis = cameraBasis(current?.cameraPose() ?? storedPose(view));
      // Drop the cube to the box's bottom, so its lowest corner or edge sits on the same 16px
      // inset as the toolbar at any angle. The home button follows, centered on the cube and
      // 8px from its left side, however wide it projects.
      const extent = (axis: Vec) =>
        (EDGE / 2) * (Math.abs(axis[0]) + Math.abs(axis[1]) + Math.abs(axis[2]));
      const drop = BOX / 2 - extent(basis.up);
      const slide = BOX / 2 - extent(basis.right);
      node.style.transform = `translateY(${drop}px) ${cubeTransform(basis)}`;
      if (home.current) home.current.style.transform = `translate(${slide}px, ${drop}px)`;
      FACES.forEach((face, index) => {
        const label = labels.current[index];
        if (label) label.style.opacity = labelOpacity(face.normal, basis.forward);
      });
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
      className="pointer-events-auto flex items-center gap-2"
    >
      <Tooltip>
        <TooltipTrigger
          ref={home}
          aria-label="Reset view to isometric"
          disabled={disabled}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg border border-input bg-popover text-foreground/75 shadow-sm outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_8%)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
          onClick={() => snap(ISOMETRIC)}
        >
          <HouseIcon aria-hidden="true" className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>Reset view</TooltipPopup>
      </Tooltip>
      {/* The shadow lives on this flat box: a filter on the cube itself would flatten its 3D. */}
      <div
        className="flex items-center justify-center drop-shadow-[0_2px_6px_rgb(0_0_0/0.55)]"
        style={{ width: BOX, height: BOX }}
      >
        <div
          ref={cube}
          className="relative [transform-style:preserve-3d]"
          style={{ width: EDGE, height: EDGE }}
        >
          {FACES.map((face, faceIndex) => {
            const right = cross(face.up, face.normal);
            return (
              <div
                key={face.preset}
                className="absolute inset-0 grid [backface-visibility:hidden] border border-[#6b6b6b] transition-colors has-[>button:hover]:bg-[color-mix(in_srgb,#2a2a2a,#7dbbff_22%)]! has-[>button:focus-visible]:bg-[color-mix(in_srgb,#2a2a2a,#7dbbff_22%)]!"
                style={{
                  transform: faceTransform(face.normal, face.up),
                  background: `color-mix(in srgb, ${FACE}, ${face.shade < 0 ? "black" : "white"} ${Math.abs(face.shade)}%)`,
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
                          className="flex cursor-pointer items-center justify-center text-[10px] font-semibold tracking-[0.04em] text-foreground/90 uppercase outline-none transition-colors hover:text-foreground focus-visible:text-foreground disabled:cursor-default"
                          onClick={() => snap(face.normal)}
                        >
                          {/* Wider than the center zone on long labels; clicks there still
                            reach the edge zones under it. */}
                          <span
                            ref={(label) => {
                              labels.current[faceIndex] = label;
                            }}
                            className="pointer-events-none whitespace-nowrap"
                          >
                            {face.tag}
                          </span>
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
                          : "cursor-pointer transition-colors hover:bg-[#7dbbff]/25"
                      }
                      onClick={() => snap(direction)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
