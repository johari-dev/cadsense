import { METERS_PER_INCH, type HoleGroup } from "~/cad/drawing/analysis";
import { holeCallout, holeReadings, type Units } from "~/cad/drawing/shopKnowledge";

/** A 10-32 tap drill (.159) through a 1 in plate: the hole the preview calls out. */
const PLATE_IN = 1;
const SAMPLE_HOLE: HoleGroup = {
  key: "preview",
  diameter: 0.159 * METERS_PER_INCH,
  hex: false,
  depth: null,
  countersink: null,
  farCountersink: null,
  bothWalls: false,
  holes: [],
  bothEnds: false,
};

// Section geometry in SVG units: the plate is 80 tall, so 80 units per inch of thickness.
const TOP = 12;
const PLATE = 80;
const HOLE_X = 76;

/**
 * Settings > Drawings preview: a section through a tapped hole and the callout a part drawing
 * prints for it, built by the same `holeCallout` the drawing panel uses. Changing the units or
 * the tap depth limit updates both, so the page shows what the two settings do.
 */
export function DrawingCalloutPreview({
  units,
  tapDepthIn,
}: {
  readonly units: Units;
  readonly tapDepthIn: number;
}) {
  const reading = holeReadings(SAMPLE_HOLE, units)[0]!;
  const callout = holeCallout(SAMPLE_HOLE, reading, units, tapDepthIn * METERS_PER_INCH);
  // Past half the plate the two threads meet; the picture stops there.
  const thread = (Math.min(tapDepthIn, PLATE_IN / 2) / PLATE_IN) * PLATE;
  const plate = units === "mm" ? "25.4 mm" : "1 in";

  return (
    <div className="flex flex-col gap-4 px-3 py-4 sm:flex-row sm:items-center sm:gap-8 sm:px-4">
      <svg
        viewBox="0 0 152 104"
        className="h-26 w-38 shrink-0 text-muted-foreground"
        role="img"
        aria-label={`Section through a 10-32 tapped hole in a ${plate} plate`}
      >
        <defs>
          <pattern
            id="drawing-preview-hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeOpacity="0.35" />
          </pattern>
        </defs>
        {/* The plate in section, cut by the drilled hole. */}
        {[
          [4, HOLE_X - 6 - 4],
          [HOLE_X + 6, 148 - HOLE_X - 6],
        ].map(([x, width]) => (
          <rect
            key={x}
            x={x}
            y={TOP}
            width={width}
            height={PLATE}
            fill="url(#drawing-preview-hatch)"
            stroke="currentColor"
            strokeOpacity="0.7"
          />
        ))}
        {/* Threads at the major diameter, tapped in from each end. */}
        <g className="text-(--accent-text)" stroke="currentColor" strokeWidth="1.5">
          {[TOP, TOP + PLATE - thread].map((y) =>
            [HOLE_X - 8, HOLE_X + 8].map((x) => (
              <line key={`${x}-${y}`} x1={x} y1={y} x2={x} y2={y + thread} strokeDasharray="3 2" />
            )),
          )}
          {/* The tap depth, dimensioned on the top thread. */}
          <line x1="116" y1={TOP} x2="116" y2={TOP + thread} strokeWidth="1" />
          <line x1="112" y1={TOP} x2="120" y2={TOP} strokeWidth="1" />
          <line x1="112" y1={TOP + thread} x2="120" y2={TOP + thread} strokeWidth="1" />
        </g>
        <line
          x1={HOLE_X}
          y1="4"
          x2={HOLE_X}
          y2="100"
          stroke="currentColor"
          strokeOpacity="0.5"
          strokeDasharray="8 2 2 2"
        />
      </svg>
      <div className="min-w-0 space-y-2">
        <p className="text-[13px] text-muted-foreground">
          A 10-32 tapped hole through a {plate} plate prints as
        </p>
        <div className="space-y-0.5 font-mono text-[13px] text-foreground tabular-nums">
          {callout.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
