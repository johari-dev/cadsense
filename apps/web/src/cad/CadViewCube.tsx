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

/** Cube edge in px, and how far each edge and corner is chamfered off. A face keeps a flat
    EDGE - 2 * CHAMFER square, wide enough for a 10px "FRONT" or "RIGHT". */
const EDGE = 48;
const CHAMFER = 6;
const HALF = EDGE / 2;
/** The flat face's side, and the width of the bevel strip along each edge. */
const FLAT = EDGE - 2 * CHAMFER;
const BEVEL = CHAMFER * Math.SQRT2;
/** How far the chamfered cube reaches along a unit direction: its farthest corner vertex. */
const extent = (axis: Vec) => {
  const sizes = axis.map(Math.abs);
  return (HALF - CHAMFER) * (sizes[0]! + sizes[1]! + sizes[2]!) + CHAMFER * Math.max(...sizes);
};
/** The cube's box: the widest it can project at any angle. */
const BOX = Math.ceil(2 * Math.hypot(HALF, HALF - CHAMFER, HALF - CHAMFER));
/** Face fill. Bevels are lighter, so edges and corners read as rounded-off geometry. */
const FACE = "#2a2a2a";
/** The hover tint, the scene's selection blue #7dbbff (as in CadCommentsCard), on any face, edge
    bevel, or corner facet. A class string, so Tailwind sees the literal colors. */
const HOVER =
  "hover:bg-[color-mix(in_srgb,#2a2a2a,#7dbbff_40%)]! focus-visible:bg-[color-mix(in_srgb,#2a2a2a,#7dbbff_40%)]!";

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
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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

/** The face color with `shade` percent of white mixed in, or of black when negative. */
const tone = (shade: number) =>
  `color-mix(in srgb, ${FACE}, ${shade < 0 ? "black" : "white"} ${Math.abs(shade)}%)`;
/** A bevel's color: lit from above, and `lift` percent lighter than the faces, so edges and
    corners read as rounded-off geometry. */
const bevelTone = (normal: Vec, lift: number) => tone(lift + 10 * normal[2]);

/**
 * Places a flat element in world space: its top-left corner at `corner`, its x axis along
 * `across`, and its front toward `normal`. Children of the cube sit at its center with a
 * top-left transform origin, so world coordinates apply directly. Its y axis is across x normal,
 * the handedness the cube transform's mirror expects, so backface culling hides the far side.
 */
function placement(corner: Vec, across: Vec, normal: Vec) {
  const down = cross(across, normal);
  return `matrix3d(${[...across, 0, ...down, 0, ...normal, 0, ...corner, 1].join(",")})`;
}
const add = (...vectors: Vec[]): Vec => [
  vectors.reduce((sum, v) => sum + v[0], 0),
  vectors.reduce((sum, v) => sum + v[1], 0),
  vectors.reduce((sum, v) => sum + v[2], 0),
];
const scale = (v: Vec, by: number): Vec => [v[0] * by, v[1] * by, v[2] * by];

/** The six flat faces, inset from the edges by the chamfer, with text upright for the preset. */
const FACE_PLATES = FACES.map((face) => {
  const across = cross(face.up, face.normal);
  const corner = add(scale(face.normal, HALF), scale(across, -FLAT / 2), scale(face.up, FLAT / 2));
  return { ...face, transform: placement(corner, across, face.normal) };
});

/** The twelve edge bevels, one strip between each pair of adjacent faces. Clicking one looks
    along the diagonal between the two faces. */
const EDGE_BEVELS = FACES.flatMap((a, i) =>
  FACES.slice(i + 1).flatMap((b) => {
    if (a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2] !== 0)
      return [];
    const direction = add(a.normal, b.normal);
    const normal = normalize(direction);
    const along = normalize(cross(a.normal, b.normal));
    const down = cross(along, normal);
    const corner = add(
      scale(direction, HALF - CHAMFER / 2),
      scale(along, -FLAT / 2),
      scale(down, -BEVEL / 2),
    );
    return [
      {
        key: `${a.preset}-${b.preset}`,
        direction,
        background: bevelTone(normal, 10),
        transform: placement(corner, along, normal),
      },
    ];
  }),
);

/** The eight corner facets, small triangles where three bevels meet. Clicking one looks from
    that corner; the front, right, top one is the isometric preset. */
const CORNER_FACETS = [-1, 1].flatMap((x) =>
  [-1, 1].flatMap((y) =>
    [-1, 1].map((z) => {
      const direction: Vec = [x, y, z];
      const normal = normalize(direction);
      // The facet's corners: the cube corner pulled in by the chamfer on two of its axes.
      const vertex = (axis: 0 | 1 | 2): Vec => [
        x * (axis === 0 ? HALF : HALF - CHAMFER),
        y * (axis === 1 ? HALF : HALF - CHAMFER),
        z * (axis === 2 ? HALF : HALF - CHAMFER),
      ];
      const [apex, left, right] = [vertex(0), vertex(1), vertex(2)];
      // Lay the triangle out apex up: x runs along the base, y from the apex toward it.
      let across = normalize(add(right, scale(left, -1)));
      const base = scale(add(left, right), 0.5);
      if (dot(cross(across, normal), add(base, scale(apex, -1))) < 0) across = scale(across, -1);
      return {
        key: `${x}${y}${z}`,
        direction,
        background: bevelTone(normal, 14),
        transform: placement(add(apex, scale(across, -BEVEL / 2)), across, normal),
      };
    }),
  ),
);

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
      const drop = BOX / 2 - extent(basis.up);
      const slide = BOX / 2 - extent(basis.right);
      node.style.transform = `translateY(${drop}px) ${cubeTransform(basis)}`;
      if (home.current) home.current.style.transform = `translate(${slide}px, ${drop}px)`;
      FACE_PLATES.forEach((face, index) => {
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
          {/* World origin at the cube's center; every surface places itself from here. */}
          <div className="absolute top-1/2 left-1/2 [transform-style:preserve-3d]">
            {FACE_PLATES.map((face, faceIndex) => (
              <Tooltip key={face.preset}>
                <TooltipTrigger
                  aria-label={`${face.label} view`}
                  disabled={disabled}
                  className={`absolute top-0 left-0 flex origin-top-left cursor-pointer items-center justify-center text-[10px] font-semibold tracking-[0.04em] text-foreground/90 uppercase outline-none transition-colors [backface-visibility:hidden] disabled:cursor-default ${disabled ? "" : HOVER}`}
                  style={{
                    width: FLAT,
                    height: FLAT,
                    transform: face.transform,
                    background: tone(face.shade),
                  }}
                  onClick={() => snap(face.normal)}
                >
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
            ))}
            {/* Edge bevels and corner facets are pointer shortcuts; the face buttons and the
                home button cover every view a keyboard needs. */}
            {EDGE_BEVELS.map((bevel) => (
              <div
                key={bevel.key}
                aria-hidden="true"
                className={`absolute top-0 left-0 origin-top-left transition-colors [backface-visibility:hidden] ${disabled ? "" : `cursor-pointer ${HOVER}`}`}
                style={{
                  width: FLAT,
                  height: BEVEL,
                  transform: bevel.transform,
                  background: bevel.background,
                }}
                onClick={() => snap(bevel.direction)}
              />
            ))}
            {CORNER_FACETS.map((facet) => (
              <div
                key={facet.key}
                aria-hidden="true"
                className={`absolute top-0 left-0 origin-top-left transition-colors [backface-visibility:hidden] [clip-path:polygon(50%_0,100%_100%,0_100%)] ${disabled ? "" : `cursor-pointer ${HOVER}`}`}
                style={{
                  width: BEVEL,
                  height: (BEVEL * Math.sqrt(3)) / 2,
                  transform: facet.transform,
                  background: facet.background,
                }}
                onClick={() => snap(facet.direction)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
