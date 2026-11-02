// The part drawing sheet: a formal drawing with third-angle views, a tolerance block, a title
// block, and a hole table.
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
  TOLERANCES,
  formatLength,
  holeCallout,
  holeReadings,
  unresolvedNotes,
  type HoleReading,
  type Stock,
  type Units,
} from "./shopKnowledge";

export interface SheetData {
  readonly part: PartAnalysis;
  readonly views: Record<"front" | "top" | "right" | "iso", DrawingView>;
  readonly name: string;
  readonly qty: number;
  readonly material: string;
  readonly requester: string;
  readonly team: string;
  readonly notes: string;
  readonly units: Units;
  readonly readings: ReadonlyMap<string, HoleReading>;
  readonly stock: Stock;
  readonly source: { readonly partId: string; readonly revision: string; readonly date: string };
}

const readingFor = (data: SheetData, group: HoleGroup) =>
  data.readings.get(group.key) ?? holeReadings(group, data.units)[0]!;

/**
 * Hole groups whose holes appear as circles in this view: the group cut down to those holes,
 * so callouts count what the view shows, and their centres in model inches.
 */
const holesIn = (data: SheetData, view: DrawingView) =>
  data.part.holes
    .map((group) => {
      const holes = group.holes.filter((hole) => isAlong(hole.direction, view.spec.toward));
      return {
        group: { ...group, holes },
        centers: holes.map((hole) => projectPoint(view.spec, hole.entry)),
      };
    })
    .filter((entry) => entry.centers.length > 0);

const holeCount = (data: SheetData, view: DrawingView) =>
  holesIn(data, view).reduce((sum, entry) => sum + entry.centers.length, 0);

/** Warnings every sheet prints: what the model shows but the sheet does not dimension. */
const sheetWarnings = (data: SheetData) => {
  const { u, v, w } = data.part.frame;
  const angled = data.part.holes
    .flatMap((group) => group.holes)
    .filter((hole) => ![u, v, w].some((axis) => isAlong(hole.direction, axis))).length;
  return [
    ...unresolvedNotes(data.part, data.units),
    ...(angled > 0
      ? [
          `${angled} ${angled > 1 ? "holes are" : "hole is"} at an angle to every view and not shown. Check the model.`,
        ]
      : []),
  ];
};

/** Overall dimensions plus hole callouts for one primary view. */
const PrimaryDims = ({
  data,
  placed,
  side,
  leftGap = 0.4,
}: {
  data: SheetData;
  placed: Placed;
  side?: Placed | undefined;
  /** How far left of the view the height dimension sits, clear of hole ordinates. */
  leftGap?: number;
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
    if (part.shape.kind !== "hex")
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
    // Turned-down sections below the length: journals share a row, each groove gets its own
    // with its distance from the left end.
    const x = (at: number) => placed.left + (at / 0.0254) * placed.scale;
    let row = 0;
    part.steps.forEach((step) => {
      const groove = step.start > 0 && step.end < su;
      if (groove) row++;
      const level = placed.bottom + 0.8 + row * 0.35;
      const size = `Ø${formatLength(step.diameter, units)}`;
      const long = formatLength(step.end - step.start, units);
      dims.push(
        <HDim
          key={`s${step.start}`}
          x1={x(step.start)}
          x2={x(step.end)}
          from={placed.bottom}
          level={level}
          text={groove ? `GROOVE ${size} × ${long}` : `${size} × ${long}`}
        />,
      );
      if (groove)
        dims.push(
          <HDim
            key={`g${step.start}`}
            x1={placed.left}
            x2={x(step.start)}
            from={placed.bottom}
            level={level + 0.3}
            text={formatLength(step.start, units)}
          />,
        );
      if (groove) row++;
    });
  } else {
    dims.push(
      <VDim
        key="v"
        y1={placed.top}
        y2={placed.bottom}
        from={placed.left}
        level={placed.left - leftGap}
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

/** Paper height PrimaryDims takes below a view: the length, then shaft step rows. */
const primaryDimsBelow = (part: PartAnalysis) => {
  const grooves = part.steps.filter((s) => s.start > 0 && s.end < part.frame.size[0]).length;
  return 0.55 + (part.steps.length ? (1 + 2 * grooves) * 0.35 + 0.1 : 0);
};

/** Leaders from one hole of each group to its callout, stacked beside the view. */
const HoleLeaders = ({
  data,
  placed,
  side = "right",
  gap = side === "below" ? 0.8 : 0.35,
}: {
  data: SheetData;
  placed: Placed;
  side?: "right" | "left" | "above" | "below";
  /** Distance from the view to the first stacked callout above or below it. */
  gap?: number;
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
          ? [cx + 0.5 * dirX, placed.top - gap - i * 0.4]
          : side === "below"
            ? [cx + 0.5 * dirX, placed.bottom + gap + i * 0.4]
            : [
                side === "left" ? placed.left - 0.35 : placed.right + 0.35,
                placed.top + 0.1 + i * 0.45,
              ];
      const text = holeCallout(group, readingFor(data, group), data.units, placed.view.spec.toward);
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

// ---------------------------------------------------------------------------
// The formal drawing. Third-angle views, title block, tolerance block, hole table for plates.

export const FormalSheet = ({ data }: { data: SheetData }) => {
  const { part, views, units } = data;
  const turned = isShaft(part.shape);
  const long = isLong(views.front);
  const warnings = sheetWarnings(data);
  // Shafts show the top view only for holes that point at it.
  const showTop = !turned || holeCount(data, views.top) > 0;
  const frontW = long ? 6.2 : 3.8;
  const scale = pickScale([
    { view: views.front, w: frontW, h: turned ? 2.2 : 2.3 },
    { view: views.right, w: long ? 1.2 : 2.2, h: 2.3 },
    ...(showTop ? [{ view: views.top, w: frontW, h: 1.4 }] : []),
  ]);
  const front = place(views.front, scale, long ? 4.1 : 3.2, turned ? 3.6 : 4.35);
  const top = place(
    views.top,
    scale,
    front.left + (front.right - front.left) / 2,
    front.top - 0.35 - ((views.top.max[1] - views.top.min[1]) * scale) / 2 - 0.15,
  );
  const right = place(
    views.right,
    scale,
    front.right + 1.0 + ((views.right.max[0] - views.right.min[0]) * scale) / 2,
    front.top + (front.bottom - front.top) / 2,
  );
  const iso = place(views.iso, pickScale([{ view: views.iso, w: 2.4, h: 1.7 }]), 8.9, 1.55);
  // Every view with holes gets callouts, so each hole's size is on the sheet. Holes also get a
  // tag and a table row for their position while rows fit; the shaft's end view holes sit on
  // its axis and need no position.
  const tags = tagHoles(data, [front, ...(showTop ? [top] : []), ...(turned ? [] : [right])]);
  const rowsFit = tags.length > TABLE_ROWS ? TABLE_ROWS - 1 : TABLE_ROWS;
  const tagged = tags.slice(0, rowsFit);
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
      {showTop && <ViewGraphic placed={top} />}
      <ViewGraphic placed={right} />
      <ViewGraphic placed={iso} showHidden={false} strokeScale={0.8} />
      <PrimaryDims data={data} placed={front} side={turned ? undefined : right} />
      {turned ? (
        <>
          <HoleLeaders data={data} placed={right} side="above" />
          <HoleLeaders data={data} placed={front} side="below" gap={primaryDimsBelow(part) + 0.3} />
        </>
      ) : (
        <>
          <HoleLeaders data={data} placed={front} side="right" />
          <HoleLeaders data={data} placed={right} side="below" gap={0.65} />
        </>
      )}
      {showTop && <HoleLeaders data={data} placed={top} side="right" />}
      {warnings.map((warning, i) => (
        <Label
          key={warning}
          x={0.5}
          y={6.35 - (warnings.length - i) * 0.15}
          size={0.09}
          anchor="start"
          fill={ACCENT}
        >
          CHECK: {warning}
        </Label>
      ))}
      {tagged.map((t) => {
        const [x, y] = t.placed.at(t.center);
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
            value="HOLE TABLE   (FROM LOWER LEFT OF EACH VIEW)"
            size={0.08}
            weight={700}
          />
          {["TAG", "VIEW", "X", "Y", "SIZE"].map((h, i) => (
            <Cell
              key={h}
              x={0.5 + TABLE_X[i]!}
              y={6.77}
              w={TABLE_W[i]!}
              h={0.2}
              value={h}
              size={0.07}
              weight={700}
            />
          ))}
          {tagged.map((t, row) => (
            <g key={t.tag}>
              {[
                t.tag,
                t.placed.view.spec.name.toUpperCase(),
                formatLength(t.x * 0.0254, units),
                formatLength(t.y * 0.0254, units),
                t.size,
              ].map((v, i) => (
                <Cell
                  key={i}
                  x={0.5 + TABLE_X[i]!}
                  y={6.97 + row * TABLE_ROW}
                  w={TABLE_W[i]!}
                  h={TABLE_ROW}
                  value={v}
                  size={0.065}
                  weight={400}
                />
              ))}
            </g>
          ))}
          {tags.length > tagged.length && (
            <Label x={0.5} y={6.97 + rowsFit * TABLE_ROW + 0.1} size={0.07} anchor="start">
              + {tags.length - tagged.length} more holes not listed; their positions are not on this
              sheet
            </Label>
          )}
        </g>
      )}

      <g>
        <Label x={tagged.length ? 4.1 : 0.5} y={6.7} size={0.09} anchor="start" weight={700}>
          NOTES:
        </Label>
        {[
          `1. BREAK ALL SHARP EDGES ${TOLERANCES[units].edges}.`,
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
          TOLERANCES[units].two,
          TOLERANCES[units].three,
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

const TABLE_X = [0, 0.4, 0.85, 1.4, 1.95];
const TABLE_W = [0.4, 0.45, 0.55, 0.55, 1.45];
// Hole table rows between its header and the sheet border.
const TABLE_ROW = 0.14;
const TABLE_ROWS = 8;

/** One tag per hole across the views: a letter per hole group, numbered on through the views. */
const tagHoles = (data: SheetData, views: readonly Placed[]) => {
  const numbered = new Map<string, number>();
  return views.flatMap((placed) =>
    holesIn(data, placed.view).flatMap(({ group, centers }) =>
      centers.map((center, index) => {
        const letter =
          "ABCDEFGH"[data.part.holes.findIndex((other) => other.key === group.key)] ?? "Z";
        const number = (numbered.get(group.key) ?? 0) + 1;
        numbered.set(group.key, number);
        return {
          tag: `${letter}${number}`,
          placed,
          center,
          x: center[0] - placed.view.min[0],
          y: center[1] - placed.view.min[1],
          size: holeCallout(
            { ...group, holes: [group.holes[index]!], bothEnds: false },
            readingFor(data, group),
            data.units,
            placed.view.spec.toward,
          ),
        };
      }),
    ),
  );
};
