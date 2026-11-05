import { METERS_PER_INCH, type HoleGroup } from "~/cad/drawing/analysis";
import { formatLength, holeCallout, holeReadings, type Units } from "~/cad/drawing/shopKnowledge";

/**
 * A 10-32 tap drill (.159) through a 1.5 in plate: the hole the preview calls out. Thick enough
 * that the default .50 tap from each end leaves an untapped band, so the limit shows.
 */
const PLATE_IN = 1.5;
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

// Section geometry in SVG units: the plate is 96 tall, so 64 units per inch of thickness.
const TOP = 12;
const PLATE = 96;
const HOLE_X = 84;
const DRILL = 7;
const MAJOR = 10;
const DIM_X = 170;

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
  const tapDepth = tapDepthIn * METERS_PER_INCH;
  const callout = holeCallout(SAMPLE_HOLE, reading, units, tapDepth);
  // Past half the plate the two threads meet; the picture stops there.
  const thread = (Math.min(tapDepthIn, PLATE_IN / 2) / PLATE_IN) * PLATE;
  const plate = units === "mm" ? "38.1 mm" : "1.5 in";
  const depthLabel = formatLength(tapDepth, units, 2);
  // The tapped length at each end: the callout taps BOTH ENDS.
  const threadSpans = [TOP, TOP + PLATE - thread];

  return (
    <div className="flex flex-col gap-4 px-3 py-4 sm:flex-row sm:items-center sm:gap-8 sm:px-4">
      <svg
        viewBox="0 0 224 120"
        className="h-[150px] w-[280px] max-w-full shrink-0 text-muted-foreground"
        role="img"
        aria-label={`Section through a 10-32 hole tapped ${depthLabel} from both ends of a ${plate} plate`}
      >
        <defs>
          <pattern
            id="drawing-preview-hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeOpacity="0.5" />
          </pattern>
        </defs>
        {/* The plate in section, cut by the drilled hole. */}
        {[
          [8, HOLE_X - DRILL - 8],
          [HOLE_X + DRILL, 160 - HOLE_X - DRILL],
        ].map(([x, width]) => (
          <rect
            key={x}
            x={x}
            y={TOP}
            width={width}
            height={PLATE}
            fill="url(#drawing-preview-hatch)"
            stroke="currentColor"
            strokeOpacity="0.8"
          />
        ))}
        <line
          x1={HOLE_X}
          y1="4"
          x2={HOLE_X}
          y2={TOP + PLATE + 8}
          stroke="currentColor"
          strokeOpacity="0.5"
          strokeDasharray="8 2 2 2"
        />
        <g className="text-(--accent-text)" stroke="currentColor" fill="none">
          {threadSpans.map((y) => (
            <g key={y}>
              {/* Major diameter dashed, tapped in from this end. */}
              {[HOLE_X - MAJOR, HOLE_X + MAJOR].map((x) => (
                <line key={x} x1={x} y1={y} x2={x} y2={y + thread} strokeDasharray="3 2" />
              ))}
              {/* The tapped length, dimensioned beside the plate. */}
              <line x1={DIM_X} y1={y} x2={DIM_X} y2={y + thread} strokeWidth="0.75" />
              <line x1={DIM_X - 5} y1={y} x2={DIM_X + 5} y2={y} strokeWidth="0.75" />
              <line
                x1={DIM_X - 5}
                y1={y + thread}
                x2={DIM_X + 5}
                y2={y + thread}
                strokeWidth="0.75"
              />
              <text
                x={DIM_X + 8}
                y={y + thread / 2 + 3.5}
                fill="currentColor"
                stroke="none"
                className="font-mono"
                fontSize="10"
              >
                {depthLabel}
              </text>
            </g>
          ))}
        </g>
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
