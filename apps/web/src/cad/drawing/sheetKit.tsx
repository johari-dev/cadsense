// SVG pieces for drawing sheets. Sheet coordinates are paper inches,
// y down, on an 11 x 8.5 letter landscape page.
import type { ReactNode } from "react";
import type { DrawingView, Vec2 } from "./analysis";

export const SHEET_W = 11;
export const SHEET_H = 8.5;
export const INK = "#111";
export const ACCENT = "#d92d20";
const LINE = 0.011;
const THIN = 0.006;
export const TEXT = 0.125;

// Drawing scales and how the title block prints them.
const SCALE_LABELS = new Map([
  [8, "8:1"],
  [6, "6:1"],
  [4, "4:1"],
  [3, "3:1"],
  [2, "2:1"],
  [1.5, "3:2"],
  [1, "1:1"],
  [0.75, "3:4"],
  [0.5, "1:2"],
  [0.375, "3:8"],
  [0.25, "1:4"],
  [0.125, "1:8"],
  [0.0625, "1:16"],
]);
const STANDARD_SCALES = [...SCALE_LABELS.keys()];

/** The largest standard scale at which every view fits its cell. */
export const pickScale = (fits: readonly { view: DrawingView; w: number; h: number }[]) =>
  STANDARD_SCALES.find((s) =>
    fits.every(
      ({ view, w, h }) =>
        (view.max[0] - view.min[0]) * s <= w && (view.max[1] - view.min[1]) * s <= h,
    ),
  ) ?? STANDARD_SCALES.at(-1)!;

export const scaleLabel = (s: number) => SCALE_LABELS.get(s) ?? `${s}:1`;

/** Maps model inches in a view to paper inches, centred in a cell. */
export interface Placed {
  readonly view: DrawingView;
  readonly scale: number;
  readonly at: (p: Vec2) => Vec2;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const place = (view: DrawingView, scale: number, cx: number, cy: number): Placed => {
  const w = (view.max[0] - view.min[0]) * scale;
  const h = (view.max[1] - view.min[1]) * scale;
  const left = cx - w / 2;
  const top = cy - h / 2;
  return {
    view,
    scale,
    at: ([x, y]) => [left + (x - view.min[0]) * scale, top + (view.max[1] - y) * scale],
    left,
    right: left + w,
    top,
    bottom: top + h,
  };
};

export const ViewGraphic = ({
  placed,
  showHidden = true,
  highlight,
  strokeScale = 1,
}: {
  placed: Placed;
  showHidden?: boolean;
  /** Circles to draw in the accent colour, matched by centre and radius in model inches. */
  highlight?: readonly { center: Vec2; radius: number }[] | undefined;
  strokeScale?: number;
}) => {
  const { view, at, scale } = placed;
  const path = (segments: DrawingView["visible"]) =>
    segments
      .map(({ from, to }) => {
        const a = at(from);
        const b = at(to);
        return `M${a[0].toFixed(4)} ${a[1].toFixed(4)}L${b[0].toFixed(4)} ${b[1].toFixed(4)}`;
      })
      .join("");
  const isHighlighted = (c: { center: Vec2; radius: number }) =>
    highlight?.some(
      (h) =>
        Math.abs(h.radius - c.radius) < 1e-3 &&
        Math.hypot(h.center[0] - c.center[0], h.center[1] - c.center[1]) < 1e-3,
    ) ?? false;
  return (
    <g strokeLinecap="round" fill="none">
      {showHidden && (
        <path
          d={path(view.hidden)}
          stroke={INK}
          strokeWidth={THIN * strokeScale}
          strokeDasharray="0.06 0.04"
        />
      )}
      <path d={path(view.visible)} stroke={INK} strokeWidth={LINE * strokeScale} />
      {view.circles
        .filter((c) => showHidden || !c.hidden)
        .map((c, i) => {
          const [x, y] = at(c.center);
          const hot = isHighlighted(c);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={c.radius * scale}
              stroke={hot ? ACCENT : INK}
              strokeWidth={(c.hidden ? THIN : hot ? LINE * 2 : LINE) * strokeScale}
              strokeDasharray={c.hidden ? "0.06 0.04" : undefined}
            />
          );
        })}
    </g>
  );
};

const Arrow = ({ tip, toward }: { tip: Vec2; toward: Vec2 }) => {
  const dx = toward[0] - tip[0];
  const dy = toward[1] - tip[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const l = 0.09;
  const w = 0.03;
  return (
    <path
      d={`M${tip[0]} ${tip[1]}L${tip[0] + ux * l - uy * w} ${tip[1] + uy * l + ux * w}L${tip[0] + ux * l + uy * w} ${tip[1] + uy * l - ux * w}Z`}
      fill={INK}
    />
  );
};

export const Label = ({
  x,
  y,
  children,
  size = TEXT,
  anchor = "middle",
  weight = 400,
  fill = INK,
  family = "var(--sheet-font)",
}: {
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  fill?: string;
  family?: string;
}) => (
  <text
    x={x}
    y={y}
    fontSize={size}
    textAnchor={anchor}
    fontWeight={weight}
    fill={fill}
    fontFamily={family}
  >
    {children}
  </text>
);

/** Horizontal dimension between two paper x positions, drawn at paper y = level. */
export const HDim = ({
  x1,
  x2,
  from,
  level,
  text,
}: {
  x1: number;
  x2: number;
  from: number;
  level: number;
  text: string;
}) => {
  const gap = 0.04;
  const dir = level > from ? 1 : -1;
  const narrow = x2 - x1 < 0.45;
  return (
    <g stroke={INK} strokeWidth={THIN}>
      <line x1={x1} y1={from + gap * dir} x2={x1} y2={level + 0.06 * dir} />
      <line x1={x2} y1={from + gap * dir} x2={x2} y2={level + 0.06 * dir} />
      {narrow ? (
        <>
          <line x1={x1 - 0.25} y1={level} x2={x2 + 0.25} y2={level} />
          <Arrow tip={[x1, level]} toward={[x1 - 1, level]} />
          <Arrow tip={[x2, level]} toward={[x2 + 1, level]} />
        </>
      ) : (
        <>
          <line x1={x1} y1={level} x2={x2} y2={level} />
          <Arrow tip={[x1, level]} toward={[x2, level]} />
          <Arrow tip={[x2, level]} toward={[x1, level]} />
        </>
      )}
      <g stroke="none">
        <Label x={(x1 + x2) / 2} y={level - 0.05}>
          {text}
        </Label>
      </g>
    </g>
  );
};

/** Vertical dimension between two paper y positions, drawn at paper x = level. Text stays horizontal. */
export const VDim = ({
  y1,
  y2,
  from,
  level,
  text,
}: {
  y1: number;
  y2: number;
  from: number;
  level: number;
  text: string;
}) => {
  const gap = 0.04;
  const dir = level > from ? 1 : -1;
  return (
    <g stroke={INK} strokeWidth={THIN}>
      <line x1={from + gap * dir} y1={y1} x2={level + 0.06 * dir} y2={y1} />
      <line x1={from + gap * dir} y1={y2} x2={level + 0.06 * dir} y2={y2} />
      <line x1={level} y1={y1} x2={level} y2={y2} />
      <Arrow tip={[level, y1]} toward={[level, y2]} />
      <Arrow tip={[level, y2]} toward={[level, y1]} />
      <g stroke="none">
        <Label x={level + 0.07 * dir} y={(y1 + y2) / 2 + 0.045} anchor={dir > 0 ? "start" : "end"}>
          {text}
        </Label>
      </g>
    </g>
  );
};

/** Leader from a point on a circle out to a text shoulder. */
export const Leader = ({
  at,
  to,
  lines,
  color = INK,
}: {
  at: Vec2;
  to: Vec2;
  lines: readonly string[];
  color?: string;
}) => {
  const right = to[0] >= at[0];
  const shoulder: Vec2 = [to[0] + (right ? 0.15 : -0.15), to[1]];
  return (
    <g stroke={color} strokeWidth={THIN} fill="none">
      <polyline points={`${at[0]},${at[1]} ${to[0]},${to[1]} ${shoulder[0]},${shoulder[1]}`} />
      <Arrow tip={at} toward={to} />
      <g stroke="none">
        {lines.map((line, i) => (
          <Label
            key={i}
            x={shoulder[0] + (right ? 0.05 : -0.05)}
            y={to[1] + 0.045 + i * TEXT * 1.25}
            anchor={right ? "start" : "end"}
            fill={color}
          >
            {line}
          </Label>
        ))}
      </g>
    </g>
  );
};

/** A paper-inch box with optional label/value, for title blocks. */
export const Cell = ({
  x,
  y,
  w,
  h,
  label,
  value,
  size = 0.15,
  weight = 500,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  value?: ReactNode;
  size?: number;
  weight?: number;
}) => (
  <g>
    <rect x={x} y={y} width={w} height={h} fill="none" stroke={INK} strokeWidth={THIN} />
    {label && (
      <Label x={x + 0.05} y={y + 0.1} size={0.065} anchor="start" fill="#555">
        {label.toUpperCase()}
      </Label>
    )}
    {value !== undefined && (
      <Label x={x + 0.06} y={y + h - 0.07} size={size} anchor="start" weight={weight}>
        {value}
      </Label>
    )}
  </g>
);
