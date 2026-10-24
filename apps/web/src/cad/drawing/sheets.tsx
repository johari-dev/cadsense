// Three sheet styles for one part: A a shop sheet with quantity check-off boxes, B a formal
// drawing with a title block, C a traveler with one row per operation.
import type { DrawingView, HoleGroup, PartAnalysis, Vec2 } from "./analysis";
import { isAlong, isShaft, projectPoint } from "./analysis";
import {
  ACCENT,
  Cell,
  HDim,
  INK,
  Label,
  Leader,
  SHEET_H,
  SHEET_W,
  VDim,
  ViewGraphic,
  pickScale,
  place,
  scaleLabel,
  type Placed,
} from "./sheetKit";
import {
  formatFraction,
  formatLength,
  holeCallout,
  holeReadings,
  type HoleReading,
  type Operation,
  type Stock,
  type Units,
} from "./shopKnowledge";

export interface SheetData {
  readonly part: PartAnalysis;
  readonly views: Record<"front" | "top" | "right" | "iso", DrawingView>;
  readonly name: string;
  readonly description: string;
  readonly qty: number;
  readonly material: string;
  readonly requester: string;
  readonly team: string;
  readonly due: string;
  readonly notes: string;
  readonly units: Units;
  readonly readings: ReadonlyMap<string, HoleReading>;
  readonly stock: Stock;
  readonly operations: readonly Operation[];
  readonly source: { readonly partId: string; readonly revision: string; readonly date: string };
}

const readingFor = (data: SheetData, group: HoleGroup) =>
  data.readings.get(group.key) ?? holeReadings(group, data.part)[0]!;

/** Hole groups whose holes appear as circles in this view, with their centres in model inches. */
const holesIn = (data: SheetData, view: DrawingView) =>
  data.part.holes
    .map((group) => ({
      group,
      centers: group.holes
        .filter((hole) => isAlong(hole.direction, view.spec.toward))
        .map((hole) => projectPoint(view.spec, hole.entry)),
    }))
    .filter((entry) => entry.centers.length > 0);

const holeCount = (data: SheetData, view: DrawingView) =>
  holesIn(data, view).reduce((sum, entry) => sum + entry.centers.length, 0);

const unitSuffix = (units: Units) => (units === "mm" ? " mm" : "");

/** Overall dimensions plus hole callouts for one primary view. */
const PrimaryDims = ({
  data,
  placed,
  side,
}: {
  data: SheetData;
  placed: Placed;
  side?: Placed | undefined;
}) => {
  const { part, units } = data;
  const [su, sv, sw] = part.frame.size;
  const dims: React.ReactNode[] = [];
  dims.push(
    <HDim
      key="u"
      x1={placed.left}
      x2={placed.right}
      from={placed.bottom}
      level={placed.bottom + 0.4}
      text={formatLength(su, units)}
    />,
  );
  if (isShaft(part.shape)) {
    // Round stock is sized by its diameter; hex by across-flats, which the end view labels.
    if (part.shape.kind === "turned")
      dims.push(
        <VDim
          key="d"
          y1={placed.top}
          y2={placed.bottom}
          from={placed.right}
          level={placed.right + 0.4}
          text={`Ø${formatLength(part.shape.diameter, units)}`}
        />,
      );
    // Blind axial holes: depth from each end face, above the view.
    part.holes
      .filter(
        (group) =>
          group.depth !== null &&
          group.holes.every((hole) => isAlong(hole.direction, part.frame.u)),
      )
      .forEach((group, gi) =>
        group.holes.forEach((hole, hi) => {
          const startsLow =
            hole.direction[0] * part.frame.u[0] +
              hole.direction[1] * part.frame.u[1] +
              hole.direction[2] * part.frame.u[2] >
            0;
          const depth = (group.depth! * placed.scale) / 0.0254;
          const x1 = startsLow ? placed.left : placed.right - depth;
          const x2 = startsLow ? placed.left + depth : placed.right;
          dims.push(
            <HDim
              key={`h${gi}${hi}`}
              x1={x1}
              x2={x2}
              from={placed.top}
              level={placed.top - 0.35 - gi * 0.3}
              text={formatLength(group.depth!, units, 2)}
            />,
          );
        }),
      );
  } else {
    dims.push(
      <VDim
        key="v"
        y1={placed.top}
        y2={placed.bottom}
        from={placed.left}
        level={placed.left - 0.4}
        text={formatLength(sv, units)}
      />,
    );
    if (side) {
      dims.push(
        <HDim
          key="w"
          x1={side.left}
          x2={side.right}
          from={side.bottom}
          level={side.bottom + 0.4}
          text={formatLength(sw, units)}
        />,
      );
    }
  }
  return <g>{dims}</g>;
};

/** Leaders from one hole of each group to its callout, stacked beside the view. */
const HoleLeaders = ({
  data,
  placed,
  side = "right",
}: {
  data: SheetData;
  placed: Placed;
  side?: "right" | "left" | "above" | "below";
}) => (
  <g>
    {holesIn(data, placed.view).map(({ group, centers }, i) => {
      const target = centers.reduce((best, c) => (c[0] + c[1] > best[0] + best[1] ? c : best));
      const [cx, cy] = placed.at(target);
      const r = (group.diameter / 0.0254 / 2) * placed.scale;
      // Callouts above or below a view near the right edge read leftward so they stay on the sheet.
      const flip = (side === "above" || side === "below") && cx + 2.2 > SHEET_W - 0.3;
      const dirX = side === "left" || flip ? -1 : 1;
      const dirY = side === "below" ? 1 : -1;
      const at: Vec2 = [cx + dirX * r * Math.SQRT1_2, cy + dirY * r * Math.SQRT1_2];
      const to: Vec2 =
        side === "above"
          ? [cx + 0.5 * dirX, placed.top - 0.35 - i * 0.4]
          : side === "below"
            ? [cx + 0.5 * dirX, placed.bottom + 0.8 + i * 0.4]
            : [
                side === "left" ? placed.left - 0.35 : placed.right + 0.35,
                placed.top + 0.1 + i * 0.45,
              ];
      const text = holeCallout(group, readingFor(data, group), data.units);
      const [main, ...rest] = text.split(" BOTH ENDS");
      return (
        <Leader
          key={group.key}
          at={at}
          to={to}
          lines={rest.length ? [main!, "BOTH ENDS"] : [text]}
        />
      );
    })}
  </g>
);

/**
 * Ordinate dimensions for hole centres: x positions above the view from its left edge,
 * y positions to the left from its bottom edge. Each unique position is labelled once.
 */
const OrdinateDims = ({
  data,
  placed,
  showY = true,
}: {
  data: SheetData;
  placed: Placed;
  showY?: boolean;
}) => {
  const { view } = placed;
  const centers = holesIn(data, view).flatMap((entry) => entry.centers);
  if (centers.length === 0) return null;
  const unique = (values: number[]) =>
    values.sort((a, b) => a - b).filter((value, i, all) => i === 0 || value - all[i - 1]! > 0.01);
  const xs = unique(centers.map((c) => c[0] - view.min[0]));
  const ys = unique(centers.map((c) => c[1] - view.min[1]));
  const level = placed.top - 0.3;
  const levelX = placed.left - 0.3;
  const fmt = (inches: number) => formatLength(inches * 0.0254, data.units);
  return (
    <g stroke={INK} strokeWidth={0.005}>
      {[0, ...xs].map((x, i) => {
        const px = placed.left + x * placed.scale;
        return (
          <g key={`x${i}`}>
            <line x1={px} y1={placed.top - 0.04} x2={px} y2={level} />
            <g stroke="none">
              <text
                transform={`rotate(-90 ${px + 0.03} ${level - 0.04})`}
                x={px + 0.03}
                y={level - 0.04}
                fontSize={0.085}
                fontFamily="var(--sheet-font)"
                fill={INK}
              >
                {i === 0 ? "0" : fmt(x)}
              </text>
            </g>
          </g>
        );
      })}
      {showY &&
        [0, ...ys].map((y, i) => {
          const py = placed.bottom - y * placed.scale;
          return (
            <g key={`y${i}`}>
              <line x1={placed.left - 0.04} y1={py} x2={levelX} y2={py} />
              <g stroke="none">
                <Label x={levelX - 0.04} y={py + 0.03} size={0.085} anchor="end">
                  {i === 0 ? "0" : fmt(y)}
                </Label>
              </g>
            </g>
          );
        })}
    </g>
  );
};

// ---------------------------------------------------------------------------
// A: shop sheet. The hand sketch, cleaned up: big quantity with tally boxes, plain words.

export const ShopSheet = ({ data }: { data: SheetData }) => {
  const { part, views } = data;
  const turned = isShaft(part.shape);
  const long = isLong(views.front);
  // The top view only earns space when it shows holes the front view cannot.
  const needsTop =
    !turned &&
    holesIn(data, views.top).some(
      ({ group }) => !holesIn(data, views.front).some((f) => f.group === group),
    );
  const scale = long
    ? pickScale([
        { view: views.front, w: 6.0, h: 1.2 },
        { view: views.right, w: 1.4, h: 1.2 },
      ])
    : pickScale([
        { view: views.front, w: turned ? 4.2 : 4.4, h: turned ? 2.8 : 3.5 },
        { view: views.right, w: turned ? 1.6 : 1.8, h: turned ? 2.8 : 3.5 },
      ]);
  const main = long
    ? place(views.front, scale, 6.15, needsTop ? 4.2 : 3.4)
    : place(views.front, scale, turned ? 7.3 : 5.4, 4.15);
  const top = needsTop ? place(views.top, scale, 6.15, 2.35) : null;
  const end = long
    ? place(views.right, scale, 9.95, main.top + (main.bottom - main.top) / 2)
    : place(views.right, scale, turned ? 3.65 : 8.9, 4.15);
  const iso = place(views.iso, pickScale([{ view: views.iso, w: 1.4, h: 1.1 }]), 9.7, 1.05);
  const qty = Math.max(1, data.qty);
  const columns = qty > 28 ? 4 : qty > 14 ? 3 : 2;
  const box = qty > 28 ? 0.24 : 0.32;
  const shown = Math.min(qty, columns * Math.floor(6.6 / (box + 0.12)));
  return (
    <>
      <Label x={0.45} y={0.75} size={0.42} anchor="start" weight={700}>
        {qty}×
      </Label>
      <Label x={0.47} y={1.02} size={0.09} anchor="start" fill="#555">
        CHECK OFF AS YOU GO
      </Label>
      {Array.from({ length: shown }, (_, i) => (
        <rect
          key={i}
          x={0.45 + (i % columns) * (box + 0.14)}
          y={1.2 + Math.floor(i / columns) * (box + 0.12)}
          width={box}
          height={box}
          fill="none"
          stroke={INK}
          strokeWidth={0.012}
          rx={0.02}
        />
      ))}
      {shown < qty && (
        <Label x={0.45} y={8.1} size={0.1} anchor="start">
          + {qty - shown} more
        </Label>
      )}
      <line x1={2.35} y1={0.35} x2={2.35} y2={8.15} stroke={INK} strokeWidth={0.008} />

      <Label x={2.6} y={0.62} size={0.13} anchor="start" fill="#555">
        {[
          data.requester || "Requested by ____",
          data.team ? `Team ${data.team}` : null,
          data.due ? `Due ${data.due}` : null,
        ]
          .filter(Boolean)
          .join("  ·  ")}
      </Label>
      <Label x={2.6} y={0.98} size={0.24} anchor="start" weight={700}>
        {data.description}
      </Label>
      <Label x={2.6} y={1.25} size={0.11} anchor="start" fill="#555">
        {data.name} · {data.material}
      </Label>
      <ViewGraphic placed={iso} showHidden={false} strokeScale={0.8} />

      {turned && (
        <Label
          x={end.left + (end.right - end.left) / 2}
          y={end.bottom + 0.45}
          size={0.1}
          fill="#555"
        >
          {part.shape.kind === "hex"
            ? `END VIEW · ${formatFraction(part.shape.flats).replace('"', "")}" HEX A/F`
            : "END VIEW"}
        </Label>
      )}
      <ViewGraphic placed={main} />
      <ViewGraphic placed={end} showHidden={part.shape.kind !== "plate"} />
      {top && <ViewGraphic placed={top} />}
      <PrimaryDims data={data} placed={main} side={turned ? undefined : end} />
      <HoleLeaders
        data={data}
        placed={turned ? end : main}
        side={turned ? "above" : long ? "below" : "right"}
      />
      {top && <HoleLeaders data={data} placed={top} side="below" />}
      {!turned &&
        (holeCount(data, (top ?? main).view) <= 12 ? (
          <OrdinateDims data={data} placed={top ?? main} />
        ) : (
          <Label x={main.left} y={main.top - 0.25} size={0.1} anchor="start" fill="#555">
            HOLE POSITIONS: CUT FROM DXF
          </Label>
        ))}

      <line x1={2.6} y1={6.35} x2={10.6} y2={6.35} stroke={INK} strokeWidth={0.006} />
      <Label x={2.6} y={6.62} size={0.1} anchor="start" weight={700}>
        HOW TO MAKE IT
      </Label>
      {data.operations.map((op, i) => (
        <Label
          key={i}
          x={2.6 + Math.floor(i / 4) * 4.1}
          y={6.9 + (i % 4) * 0.27}
          size={0.12}
          anchor="start"
        >
          {`${i + 1}. ${op.title}: ${op.detail}`}
        </Label>
      ))}
      {data.notes && (
        <Label x={2.6} y={8.12} size={0.11} anchor="start" fill={ACCENT}>
          NOTE: {data.notes}
        </Label>
      )}
      <Label x={10.6} y={8.12} size={0.08} anchor="end" fill="#777">
        SCALE {scaleLabel(scale)} · INCH · {data.source.revision}
      </Label>
    </>
  );
};

// ---------------------------------------------------------------------------
// B: formal drawing. Third-angle views, title block, tolerance block, hole table for plates.

export const FormalSheet = ({ data }: { data: SheetData }) => {
  const { part, views, units } = data;
  const turned = isShaft(part.shape);
  const long = isLong(views.front);
  const frontW = long ? 6.2 : 3.8;
  const scale = pickScale([
    { view: views.front, w: frontW, h: turned ? 2.2 : 2.3 },
    { view: views.right, w: long ? 1.2 : 2.2, h: 2.3 },
    ...(turned ? [] : [{ view: views.top, w: frontW, h: 1.4 }]),
  ]);
  const front = place(views.front, scale, long ? 4.1 : 3.2, turned ? 3.6 : 4.35);
  const top = place(
    views.top,
    scale,
    3.2,
    front.top - 0.35 - ((views.top.max[1] - views.top.min[1]) * scale) / 2 - 0.15,
  );
  const right = place(
    views.right,
    scale,
    front.right + 1.0 + ((views.right.max[0] - views.right.min[0]) * scale) / 2,
    front.top + (front.bottom - front.top) / 2,
  );
  const iso = place(views.iso, pickScale([{ view: views.iso, w: 2.4, h: 1.7 }]), 8.9, 1.55);
  const tagged = turned ? [] : tagHoles(data, views.front);
  const zones = [0, 1, 2, 3];
  return (
    <>
      <rect
        x={0.25}
        y={0.25}
        width={SHEET_W - 0.5}
        height={SHEET_H - 0.5}
        fill="none"
        stroke={INK}
        strokeWidth={0.02}
      />
      {zones.map((z) => (
        <g key={z}>
          <Label x={0.25 + (z + 0.5) * ((SHEET_W - 0.5) / 4)} y={0.2} size={0.08}>
            {4 - z}
          </Label>
          <Label x={0.14} y={0.25 + (z + 0.5) * ((SHEET_H - 0.5) / 4)} size={0.08}>
            {"DCBA"[z]}
          </Label>
        </g>
      ))}
      <ViewGraphic placed={front} />
      {!turned && <ViewGraphic placed={top} />}
      <ViewGraphic placed={right} />
      <ViewGraphic placed={iso} showHidden={false} strokeScale={0.8} />
      <PrimaryDims data={data} placed={front} side={turned ? undefined : right} />
      {turned ? (
        <HoleLeaders data={data} placed={right} side="above" />
      ) : (
        <HoleLeaders data={data} placed={front} side="right" />
      )}
      {tagged.map((t) => {
        const [x, y] = front.at(t.center);
        return (
          <Label key={t.tag} x={x + 0.09} y={y - 0.06} size={0.075} anchor="start" fill="#444">
            {t.tag}
          </Label>
        );
      })}

      {tagged.length > 0 && (
        <g>
          <Cell
            x={0.5}
            y={6.55}
            w={3.4}
            h={0.22}
            value="HOLE TABLE   (FROM LOWER LEFT, FRONT VIEW)"
            size={0.08}
            weight={700}
          />
          {["TAG", "X", "Y", "SIZE"].map((h, i) => (
            <Cell
              key={h}
              x={0.5 + [0, 0.45, 1.05, 1.65][i]!}
              y={6.77}
              w={[0.45, 0.6, 0.6, 1.75][i]!}
              h={0.2}
              value={h}
              size={0.07}
              weight={700}
            />
          ))}
          {tagged.slice(0, 6).map((t, row) => (
            <g key={t.tag}>
              {[
                t.tag,
                formatLength(t.x * 0.0254, units),
                formatLength(t.y * 0.0254, units),
                t.size,
              ].map((v, i) => (
                <Cell
                  key={i}
                  x={0.5 + [0, 0.45, 1.05, 1.65][i]!}
                  y={6.97 + row * 0.2}
                  w={[0.45, 0.6, 0.6, 1.75][i]!}
                  h={0.2}
                  value={v}
                  size={0.075}
                  weight={400}
                />
              ))}
            </g>
          ))}
          {tagged.length > 6 && (
            <Label x={0.5} y={8.2} size={0.07} anchor="start">
              + {tagged.length - 6} more rows on sheet 2
            </Label>
          )}
        </g>
      )}

      <g>
        <Label x={tagged.length ? 4.1 : 0.5} y={6.7} size={0.09} anchor="start" weight={700}>
          NOTES:
        </Label>
        {[
          "1. BREAK ALL SHARP EDGES .010-.020.",
          `2. MATERIAL: ${data.material.toUpperCase()}.`,
          `3. STOCK: ${data.stock.description.toUpperCase()}.`,
          ...(data.notes ? [`4. ${data.notes.toUpperCase()}`] : []),
        ].map((line, i) => (
          <Label
            key={i}
            x={tagged.length ? 4.1 : 0.5}
            y={6.9 + i * 0.17}
            size={0.08}
            anchor="start"
          >
            {line}
          </Label>
        ))}
      </g>

      <g>
        <Cell x={6.3} y={6.45} w={1.5} h={1.8} />
        <Label x={6.36} y={6.6} size={0.065} anchor="start" fill="#555">
          UNLESS OTHERWISE SPECIFIED
        </Label>
        {[
          `DIMENSIONS IN ${units === "mm" ? "MM" : "INCHES"}`,
          ".XX  ±.01",
          ".XXX ±.005",
          "ANGLES ±0.5°",
          "THIRD ANGLE PROJECTION",
        ].map((line, i) => (
          <Label key={i} x={6.36} y={6.82 + i * 0.17} size={0.075} anchor="start">
            {line}
          </Label>
        ))}
        <ThirdAngleSymbol x={6.6} y={7.85} />
        <Cell
          x={7.8}
          y={6.45}
          w={2.95}
          h={0.6}
          label="Part"
          value={truncate(data.name, 34)}
          size={0.12}
          weight={700}
        />
        <Cell
          x={7.8}
          y={7.05}
          w={1.5}
          h={0.4}
          label="Material"
          value={truncate(data.material, 18)}
          size={0.09}
        />
        <Cell
          x={9.3}
          y={7.05}
          w={0.7}
          h={0.4}
          label="Qty"
          value={`${data.qty}`}
          size={0.12}
          weight={700}
        />
        <Cell
          x={10.0}
          y={7.05}
          w={0.75}
          h={0.4}
          label="Scale"
          value={scaleLabel(scale)}
          size={0.1}
        />
        <Cell
          x={7.8}
          y={7.45}
          w={1.5}
          h={0.4}
          label="Requested by"
          value={truncate(data.requester || "—", 18)}
          size={0.09}
        />
        <Cell x={9.3} y={7.45} w={1.45} h={0.4} label="Team" value={data.team || "—"} size={0.1} />
        <Cell x={7.8} y={7.85} w={1.0} h={0.4} label="Drawn" value="CADsense" size={0.08} />
        <Cell x={8.8} y={7.85} w={0.8} h={0.4} label="Date" value={data.source.date} size={0.08} />
        <Cell
          x={9.6}
          y={7.85}
          w={0.65}
          h={0.4}
          label="Rev"
          value={data.source.revision.slice(0, 6)}
          size={0.08}
        />
        <Cell x={10.25} y={7.85} w={0.5} h={0.4} label="Sheet" value="1/1" size={0.08} />
      </g>
    </>
  );
};

/** Long parts (tubes, shafts) get a full-width row instead of the usual view grid. */
const isLong = (view: DrawingView) => (view.max[0] - view.min[0]) / (view.max[1] - view.min[1]) > 4;

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const ThirdAngleSymbol = ({ x, y }: { x: number; y: number }) => (
  <g stroke={INK} strokeWidth={0.008} fill="none">
    <path d={`M${x} ${y - 0.12}L${x + 0.3} ${y - 0.2}L${x + 0.3} ${y + 0.2}L${x} ${y + 0.12}Z`} />
    <circle cx={x + 0.62} cy={y} r={0.2} />
    <circle cx={x + 0.62} cy={y} r={0.12} />
  </g>
);

const tagHoles = (data: SheetData, view: DrawingView) =>
  holesIn(data, view).flatMap(({ group, centers }, gi) =>
    centers.map((center, hi) => ({
      tag: `${"ABCDEFGH"[gi] ?? "Z"}${hi + 1}`,
      center,
      x: center[0] - view.min[0],
      y: center[1] - view.min[1],
      size: holeCallout(
        { ...group, holes: [group.holes[0]!], bothEnds: false },
        readingFor(data, group),
        data.units,
      ),
    })),
  );

// ---------------------------------------------------------------------------
// C: traveler. One row per operation, each with the view it needs and a sign-off.

export const TravelerSheet = ({ data }: { data: SheetData }) => {
  const { part, views } = data;
  const turned = isShaft(part.shape);
  const iso = place(views.iso, pickScale([{ view: views.iso, w: 2.4, h: 1.9 }]), 1.75, 2.75);
  const front = place(views.front, pickScale([{ view: views.front, w: 2.1, h: 1.5 }]), 1.55, 5.0);
  const rows = data.operations.slice(0, 7);
  const rowH = Math.min(0.95, 6.3 / Math.max(rows.length, 1));
  const holeView = turned ? views.right : views.front;
  return (
    <>
      <rect
        x={0.35}
        y={0.35}
        width={10.3}
        height={1.05}
        fill="#f2f2f2"
        stroke={INK}
        strokeWidth={0.008}
      />
      <Label x={0.5} y={0.68} size={0.1} anchor="start" fill="#555">
        TRAVELER ·{" "}
        {[
          data.requester,
          data.team ? `Team ${data.team}` : null,
          data.due ? `due ${data.due}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "unassigned"}
      </Label>
      <Label x={0.5} y={1.0} size={0.22} anchor="start" weight={700}>
        {data.description}
      </Label>
      <Label x={0.5} y={1.25} size={0.1} anchor="start" fill="#555">
        {data.name} · {data.material} · stock: {data.stock.description}
      </Label>
      <Label x={10.5} y={1.05} size={0.5} anchor="end" weight={700}>
        {data.qty}×
      </Label>

      <ViewGraphic placed={iso} showHidden={false} />
      <ViewGraphic placed={front} />
      <PrimaryDims data={data} placed={front} />
      <Label x={0.5} y={7.4} size={0.075} anchor="start" fill="#555">
        FROM ONSHAPE PART {data.source.partId}
      </Label>
      <Label x={0.5} y={7.55} size={0.075} anchor="start" fill="#555">
        REVISION {data.source.revision} · {data.source.date}
      </Label>
      <Label x={0.5} y={7.85} size={0.075} anchor="start" fill={ACCENT}>
        REGENERATE IF THE MODEL CHANGES
      </Label>

      {["#", "MACHINE", "OPERATION", "", "DONE / BY"].map((h, i) => (
        <Label
          key={i}
          x={[3.55, 3.9, 4.9, 8.4, 9.7][i]!}
          y={1.68}
          size={0.08}
          anchor="start"
          weight={700}
        >
          {h}
        </Label>
      ))}
      {rows.map((op, i) => {
        const y = 1.78 + i * rowH;
        const mini = op.holeKey
          ? place(
              holeView,
              pickScale([{ view: holeView, w: 1.1, h: rowH - 0.2 }]),
              8.95,
              y + rowH / 2,
            )
          : null;
        const highlight = op.holeKey
          ? holesIn(data, holeView)
              .find((entry) => entry.group.key === op.holeKey)
              ?.centers.map((center) => ({
                center,
                radius: data.part.holes.find((g) => g.key === op.holeKey)!.diameter / 0.0254 / 2,
              }))
          : undefined;
        return (
          <g key={i}>
            <rect
              x={3.45}
              y={y}
              width={7.2}
              height={rowH}
              fill="none"
              stroke={INK}
              strokeWidth={0.006}
            />
            <Label x={3.55} y={y + 0.3} size={0.16} anchor="start" weight={700}>
              {i + 1}
            </Label>
            <rect x={3.9} y={y + 0.14} width={0.85} height={0.22} rx={0.04} fill="#e8e8e8" />
            <Label x={4.325} y={y + 0.295} size={0.09} weight={700}>
              {op.machine.toUpperCase()}
            </Label>
            <Label x={4.9} y={y + 0.3} size={0.14} anchor="start" weight={700}>
              {op.title}
            </Label>
            <Label x={4.9} y={y + 0.52} size={0.11} anchor="start">
              {truncate(op.detail, 52)}
            </Label>
            {mini && <ViewGraphic placed={mini} highlight={highlight} strokeScale={0.7} />}
            <rect
              x={9.75}
              y={y + 0.15}
              width={0.22}
              height={0.22}
              fill="none"
              stroke={INK}
              strokeWidth={0.01}
            />
            <line
              x1={10.05}
              y1={y + 0.37}
              x2={10.55}
              y2={y + 0.37}
              stroke={INK}
              strokeWidth={0.006}
            />
          </g>
        );
      })}
      {data.notes && (
        <Label x={3.45} y={8.15} size={0.11} anchor="start" fill={ACCENT}>
          NOTE: {data.notes}
        </Label>
      )}
    </>
  );
};

export const VARIANTS = [
  { key: "A", name: "Shop sheet", Sheet: ShopSheet },
  { key: "B", name: "Formal drawing", Sheet: FormalSheet },
  { key: "C", name: "Traveler", Sheet: TravelerSheet },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];

/** One-line description like the hand sketch: "3/8" round shaft, 1-1/2" long, 10-32 tap .50 deep both ends". */
export const describePart = (
  part: PartAnalysis,
  readings: ReadonlyMap<string, HoleReading>,
  units: Units,
) => {
  const holes = part.holes.map((group) => {
    const reading = readings.get(group.key) ?? holeReadings(group, part)[0]!;
    const what = reading.tap ? `${reading.tap} tap` : `Ø${formatLength(group.diameter, units)}`;
    const depth =
      group.depth === null
        ? isShaft(part.shape)
          ? "thru bore"
          : "thru"
        : `${formatLength(group.depth, units, 2)}${unitSuffix(units)} deep`;
    const count = group.bothEnds
      ? " both ends"
      : group.holes.length > 1
        ? `, ${group.holes.length}×`
        : "";
    return `${what} ${depth}${count}`;
  });
  const [su, sv, sw] = part.frame.size;
  const base =
    part.shape.kind === "turned"
      ? `${formatFraction(part.shape.diameter)} round, ${formatFraction(part.shape.length)} long`
      : part.shape.kind === "hex"
        ? `${formatFraction(part.shape.flats)} hex, ${formatFraction(part.shape.length)} long`
        : part.shape.kind === "plate"
          ? `${formatFraction(sw)} plate, ${formatFraction(su)} × ${formatFraction(sv)}`
          : part.shape.kind === "tube"
            ? `${formatFraction(sv)} × ${formatFraction(sw)} tube, ${formatFraction(su)} long`
            : `${formatFraction(su)} × ${formatFraction(sv)} × ${formatFraction(sw)} block`;
  const text = [
    base,
    ...holes.slice(0, 2),
    ...(holes.length > 2 ? [`+${holes.length - 2} more holes`] : []),
  ].join(", ");
  return truncate(text, 64);
};
