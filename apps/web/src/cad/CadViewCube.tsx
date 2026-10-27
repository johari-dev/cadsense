// The viewport's orientation cube, as in Onshape, Fusion, and SolidWorks. It turns with the live
// camera, and clicking a face, edge, or corner snaps the camera to look along that direction.
// Drawn as one SVG, projected from the camera on each frame, so it needs neither a second WebGL
// context nor the browser's 3D compositing (which sorted shared-edge planes unreliably).
import type { CadViewState } from "@cadsense/contracts";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { HouseIcon } from "~/lib/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import { CAD_VIEW_DIRECTIONS, cadPresetUp } from "./CadSceneModel";

type Vec = readonly [number, number, number];
type Preset = Extract<CadViewState["camera"], { kind: "preset" }>["preset"];

/** Cube edge in px, and how far each edge and corner is chamfered off. The chamfer sets the
    corner facets' size (CHAMFER * sqrt 2 on a side, about 14px), large enough to click easily.
    A face keeps a flat EDGE - 2 * CHAMFER square, wide enough for a 10px "FRONT" or "RIGHT". */
const EDGE = 56;
const CHAMFER = 10;
const HALF = EDGE / 2;
/** The flat face's side. */
const FLAT = EDGE - 2 * CHAMFER;
/** How far the chamfered cube reaches along a unit direction: its farthest corner vertex. */
const extent = (axis: Vec) => {
  const sizes = axis.map(Math.abs);
  return (HALF - CHAMFER) * (sizes[0]! + sizes[1]! + sizes[2]!) + CHAMFER * Math.max(...sizes);
};
/** The cube's box: the widest it can project at any angle. */
const BOX = Math.ceil(2 * Math.hypot(HALF, HALF - CHAMFER, HALF - CHAMFER));
/** Face fill. Bevels are lighter, so edges and corners read as rounded-off geometry. */
const FACE = "#2a2a2a";
/** The hover tint: the face fill with 40% of the scene's selection blue #7dbbff (as in
    CadCommentsCard), on any face, bevel, or facet, or a face whose button has keyboard focus.
    A class string, so Tailwind sees the literal color. */
const HOVER = "hover:fill-[#4b647f] data-focused:fill-[#4b647f]";

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

/** Label opacity for a face: full when it faces the camera, gone before it turns edge-on, where
    the squeezed text would read as noise. */
const labelOpacity = (normal: Vec, forward: Vec) =>
  String(Math.min(1, Math.max(0, (-dot(normal, forward) - 0.2) / 0.3)));

/** `base` with `share` (0 to 1) of `other` mixed in, as hex, for SVG fill attributes. */
function mix(base: string, other: string, share: number) {
  const channel = (hex: string, index: number) =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(base, index) * (1 - share) + channel(other, index) * share)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
/** The face color with `shade` percent of white mixed in, or of black when negative. */
const tone = (shade: number) => mix(FACE, shade < 0 ? "#000000" : "#ffffff", Math.abs(shade) / 100);
/** A bevel's color: lit from above, and `lift` percent lighter than the faces, so edges and
    corners read as rounded-off geometry. */
const bevelTone = (normal: Vec, lift: number) => tone(lift + 10 * normal[2]);

const add = (...vectors: Vec[]): Vec => [
  vectors.reduce((sum, v) => sum + v[0], 0),
  vectors.reduce((sum, v) => sum + v[1], 0),
  vectors.reduce((sum, v) => sum + v[2], 0),
];
const scale = (v: Vec, by: number): Vec => [v[0] * by, v[1] * by, v[2] * by];

/**
 * The chamfered cube as 26 flat polygons in world space: six faces inset by the chamfer, a
 * bevel strip between each pair of adjacent faces, and a triangular facet where three bevels
 * meet. Each looks along `direction` when clicked; the front, right, top corner is isometric.
 * The solid is convex, so under the cube's orthographic projection the polygons facing the
 * camera never overlap, and hiding the rest draws it exactly with no depth sorting.
 */
type Surface = { key: string; corners: Vec[]; normal: Vec; direction: Vec; fill: string };

const FACE_SURFACES = FACES.map((face) => {
  const across = cross(face.up, face.normal);
  const center = scale(face.normal, HALF);
  const corner = (x: number, y: number) =>
    add(center, scale(across, (x * FLAT) / 2), scale(face.up, (y * FLAT) / 2));
  return {
    ...face,
    key: face.preset,
    across,
    center,
    corners: [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)],
    direction: face.normal,
    fill: tone(face.shade),
  };
});

const BEVEL_SURFACES: Surface[] = FACES.flatMap((a, i) =>
  FACES.slice(i + 1).flatMap((b) => {
    if (dot(a.normal, b.normal) !== 0) return [];
    const direction = add(a.normal, b.normal);
    const along = scale(normalize(cross(a.normal, b.normal)), FLAT / 2);
    // The bevel's long sides: the edges of the two faces it joins.
    const onA = add(scale(a.normal, HALF), scale(b.normal, HALF - CHAMFER));
    const onB = add(scale(b.normal, HALF), scale(a.normal, HALF - CHAMFER));
    return [
      {
        key: `${a.preset}-${b.preset}`,
        corners: [
          add(onA, along),
          add(onA, scale(along, -1)),
          add(onB, scale(along, -1)),
          add(onB, along),
        ],
        normal: normalize(direction),
        direction,
        fill: bevelTone(normalize(direction), 10),
      },
    ];
  }),
);

const CORNER_SURFACES: Surface[] = [-1, 1].flatMap((x) =>
  [-1, 1].flatMap((y) =>
    [-1, 1].map((z) => {
      const direction: Vec = [x, y, z];
      // The facet's corners: the cube corner pulled in by the chamfer on two of its axes.
      const vertex = (axis: 0 | 1 | 2): Vec => [
        x * (axis === 0 ? HALF : HALF - CHAMFER),
        y * (axis === 1 ? HALF : HALF - CHAMFER),
        z * (axis === 2 ? HALF : HALF - CHAMFER),
      ];
      return {
        key: `${x}${y}${z}`,
        corners: [vertex(0), vertex(1), vertex(2)],
        normal: normalize(direction),
        direction,
        fill: bevelTone(normalize(direction), 14),
      };
    }),
  ),
);

const SURFACES: Surface[] = [...FACE_SURFACES, ...BEVEL_SURFACES, ...CORNER_SURFACES];

/** A surface's tooltip: "Front view", "Front right view", "Isometric view". */
function viewName(direction: Vec) {
  if (same(direction, ISOMETRIC)) return "Isometric view";
  const names = FACES.filter((face) => dot(face.normal, direction) > 0).map((face) => face.label);
  return `${[names[0], ...names.slice(1).map((name) => name.toLowerCase())].join(" ")} view`;
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
  const home = useRef<HTMLButtonElement>(null);
  const polygons = useRef<Array<SVGPolygonElement | null>>([]);
  const labels = useRef<Array<SVGTextElement | null>>([]);
  // Follows the renderer's frames, coalesced in a microtask like the comment markers, so a
  // still camera costs nothing and the cube never lags the model by a frame. Each frame
  // projects every surface, hides those facing away, and re-aims the face labels.
  useLayoutEffect(() => {
    const current = renderer?.current;
    const draw = () => {
      const { right, up, forward } = cameraBasis(current?.cameraPose() ?? storedPose(view));
      // Drop the cube to the box's bottom, so its lowest corner or edge sits on the same 16px
      // inset as the toolbar at any angle. The home button follows, centered on the cube and
      // 8px from its left side, however wide it projects.
      const drop = BOX / 2 - extent(up);
      const slide = BOX / 2 - extent(right);
      if (home.current) home.current.style.transform = `translate(${slide}px, ${drop}px)`;
      // Screen x runs along the camera's right, and SVG y down, against its up.
      const project = (point: Vec) => [dot(point, right), drop - dot(point, up)] as const;
      SURFACES.forEach((surface, index) => {
        const polygon = polygons.current[index];
        if (!polygon) return;
        const facing = dot(surface.normal, forward) < -1e-6;
        polygon.style.display = facing ? "" : "none";
        if (facing)
          polygon.setAttribute(
            "points",
            surface.corners.map((corner) => project(corner).join(",")).join(" "),
          );
      });
      // A label lives in its face's plane: text x along the face's right, text y down its up.
      // Under an orthographic projection that plane maps to the screen by one affine matrix.
      FACE_SURFACES.forEach((face, index) => {
        const label = labels.current[index];
        if (!label) return;
        const [x, y] = project(face.center);
        label.setAttribute(
          "transform",
          `matrix(${[
            dot(face.across, right),
            -dot(face.across, up),
            -dot(face.up, right),
            dot(face.up, up),
            x,
            y,
          ].join(" ")})`,
        );
        label.style.opacity = labelOpacity(face.normal, forward);
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
      {/* Keyboard access to the six faces. The buttons are visually hidden; focusing one lights
          its face on the cube. Bevels and corner facets are pointer shortcuts. */}
      <div className="sr-only">
        {FACE_SURFACES.map((face, index) => (
          <button
            key={face.key}
            type="button"
            disabled={disabled}
            onFocus={() => polygons.current[index]?.setAttribute("data-focused", "")}
            onBlur={() => polygons.current[index]?.removeAttribute("data-focused")}
            onClick={() => snap(face.normal)}
          >
            {`${face.label} view`}
          </button>
        ))}
      </div>
      <svg
        aria-hidden="true"
        width={BOX}
        height={BOX}
        viewBox={`${-BOX / 2} ${-BOX / 2} ${BOX} ${BOX}`}
        className="drop-shadow-[0_2px_6px_rgb(0_0_0/0.55)]"
      >
        {SURFACES.map((surface, index) => (
          <polygon
            key={surface.key}
            ref={(polygon) => {
              polygons.current[index] = polygon;
            }}
            fill={surface.fill}
            // A hairline in a darker tone defines each edge and hides antialiasing seams
            // between polygons that share one.
            stroke="#000000"
            strokeOpacity={0.3}
            strokeWidth={0.75}
            strokeLinejoin="round"
            className={disabled ? undefined : `cursor-pointer transition-colors ${HOVER}`}
            onClick={() => snap(surface.direction)}
          >
            <title>{viewName(surface.direction)}</title>
          </polygon>
        ))}
        {FACE_SURFACES.map((face, index) => (
          <text
            key={face.key}
            ref={(label) => {
              labels.current[index] = label;
            }}
            textAnchor="middle"
            dominantBaseline="central"
            className="pointer-events-none fill-foreground/90 text-[10px] font-semibold tracking-[0.04em]"
          >
            {face.tag.toUpperCase()}
          </text>
        ))}
      </svg>
    </div>
  );
}
