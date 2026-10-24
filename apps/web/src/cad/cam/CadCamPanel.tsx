// The right panel's CAM section: a router plan for plates, previewed as tool paths with a cut
// simulation, plus a DXF the team's CAM program can take. A group keeps only its plates.
import type { ScopedThreadRef } from "@cadsense/contracts";
import { CaretLeftIcon, CaretRightIcon, DownloadIcon, PlayIcon } from "~/lib/icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { useRightPanelStore, type RightPanelDrawing } from "../../rightPanelStore";
import type { Vec2 } from "../drawing/analysis";
import { resolveDrawingSheets } from "../drawing/drawingModel";
import { routeCounts, useCadSnapshotAssets, useShopRoutes } from "../useCadSnapshotAssets";
import { downloadText, plateDxf } from "./dxf";
import { plateGeometry, type PlateGeometry } from "./plateGeometry";
import { DEFAULT_CAM, fraction, planPlate, type CamOperation, type CamSettings } from "./toolpaths";

const TOOLS = [0.125, 0.1575, 0.1875, 0.25] as const; // 1/8", 4 mm, 3/16", 1/4"
const OP_COLOR: Record<CamOperation["kind"], string> = {
  pocket: "#3fb68b",
  bore: "#e8c547",
  cutout: "#4da3ff",
  profile: "#ff6b6b",
};

export function CadCamPanel({
  threadRef,
  cam,
}: {
  threadRef: ScopedThreadRef;
  cam: RightPanelDrawing;
}) {
  const { manifest, error, setError, fetchAsset, analyze } = useCadSnapshotAssets(
    threadRef,
    cam.snapshotId,
  );
  const [index, setIndex] = useState(0);
  const [settings, setSettings] = useState<CamSettings>(DEFAULT_CAM);
  const [plates, setPlates] = useState<Record<string, PlateGeometry | "not-a-plate">>({});

  const candidates = useMemo(
    () => (manifest ? resolveDrawingSheets(manifest, cam.occurrenceIds) : []),
    [manifest, cam.occurrenceIds],
  );
  const isGroup = useMemo(
    () =>
      !!manifest &&
      cam.occurrenceIds.some(
        (id) => manifest.nodes.find((node) => node.id === id)?.kind !== "part",
      ),
    [manifest, cam.occurrenceIds],
  );
  const routes = useShopRoutes(candidates, fetchAsset, isGroup, setError);
  const parts = useMemo(
    () =>
      isGroup ? candidates.filter((candidate) => routes?.[candidate.sha256] === "cnc") : candidates,
    [isGroup, candidates, routes],
  );
  const entry = parts[Math.min(index, Math.max(0, parts.length - 1))] ?? null;
  const plate = entry ? plates[entry.sha256] : undefined;
  const plan = useMemo(
    () => (plate && plate !== "not-a-plate" ? planPlate(plate, settings) : null),
    [plate, settings],
  );

  useEffect(() => {
    if (!entry || !analyze || plates[entry.sha256]) return;
    let live = true;
    analyze(entry.sha256)
      .then(
        (part) =>
          live &&
          setPlates((current) => ({
            ...current,
            [entry.sha256]: plateGeometry(part) ?? "not-a-plate",
          })),
      )
      .catch((cause: unknown) => live && setError(String(cause)));
    return () => {
      live = false;
    };
  }, [entry, analyze, plates, setError]);

  const openDrawing = () =>
    useRightPanelStore.getState().openDrawing(threadRef, {
      snapshotId: cam.snapshotId,
      occurrenceIds: cam.occurrenceIds,
      title: cam.title,
    });

  if (error)
    return <div className="p-4 text-sm text-destructive">Could not plan this part: {error}</div>;
  if (!manifest || (isGroup && !routes))
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {manifest ? "Sorting the parts…" : "Loading the model…"}
      </div>
    );
  if (parts.length === 0) {
    const counts = routes ? routeCounts(candidates, routes) : null;
    return (
      <div className="space-y-3 p-4 text-sm text-muted-foreground">
        <p>
          No plates in {cam.title}.
          {counts?.drawing ? ` ${counts.drawing} parts there need shop drawings instead.` : ""}
        </p>
        {counts?.drawing ? (
          <Button size="sm" variant="outline" onClick={openDrawing}>
            Make shop drawings
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cad-cam-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{entry?.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {plate && plate !== "not-a-plate"
              ? `${fraction(plate.thickness)} plate, ${plate.width.toFixed(2)} × ${plate.height.toFixed(2)} in · ${entry?.qty}× ${parts.length > 1 ? `· plate ${index + 1} of ${parts.length}` : "in the assembly"}`
              : `${entry?.qty}× in the assembly`}
          </div>
        </div>
        {parts.length > 1 && (
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous plate"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <CaretLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next plate"
              disabled={index >= parts.length - 1}
              onClick={() => setIndex(index + 1)}
            >
              <CaretRightIcon />
            </Button>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={!plate || plate === "not-a-plate"}
          onClick={() =>
            plate &&
            plate !== "not-a-plate" &&
            entry &&
            downloadText(`${entry.name.replace(/[^\w.-]+/g, "_")}.dxf`, plateDxf(plate))
          }
        >
          <DownloadIcon />
          DXF
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-border px-3 py-2 text-xs">
        <Field label="Tool">
          <select
            aria-label="Tool diameter"
            className={inputClass}
            value={settings.tool}
            onChange={(e) => setSettings({ ...settings, tool: Number(e.target.value) })}
          >
            {TOOLS.map((tool) => (
              <option key={tool} value={tool}>
                {tool === 0.1575 ? "4 mm" : fraction(tool)} end mill
              </option>
            ))}
          </select>
        </Field>
        <Field label="Depth per pass">
          <NumberInput
            value={settings.stepdown}
            step={0.005}
            onChange={(stepdown) => setSettings({ ...settings, stepdown })}
            suffix="in"
          />
        </Field>
        <Field label="Feed">
          <NumberInput
            value={settings.feed}
            step={5}
            onChange={(feed) => setSettings({ ...settings, feed })}
            suffix="in/min"
          />
        </Field>
        <Field label="Tabs">
          <NumberInput
            value={settings.tabs}
            step={1}
            min={0}
            onChange={(tabs) => setSettings({ ...settings, tabs: Math.round(tabs) })}
          />
        </Field>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {plate === "not-a-plate" ? (
          <div className="space-y-3 p-4 text-sm text-muted-foreground">
            <p>
              This part is not a flat plate, so it is not cut on the router. It needs a shop
              drawing.
            </p>
            <Button size="sm" variant="outline" onClick={openDrawing}>
              Make part drawing
            </Button>
          </div>
        ) : plate && plan ? (
          <>
            <Preview plate={plate} operations={plan.operations} tool={settings.tool} />
            <div className="space-y-1.5 px-3 py-3 text-[13px]">
              {plan.operations.map((op, i) => (
                <div key={i} className="flex items-baseline gap-2" data-testid="cad-cam-operation">
                  <span
                    className="size-2.5 shrink-0 translate-y-[1px] rounded-full"
                    style={{ background: OP_COLOR[op.kind] }}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {i + 1}. {op.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {op.passes} pass{op.passes === 1 ? "" : "es"} · {formatMinutes(op.minutes)}
                  </span>
                </div>
              ))}
              {plan.drill.map((hole) => (
                <div
                  key={hole.diameter}
                  className="flex items-baseline gap-2 text-muted-foreground"
                >
                  <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground" />
                  <span className="flex-1">
                    Drill {hole.count}× Ø{hole.diameter.toFixed(3).replace(/^0/, "")} by hand:
                    smaller than the tool
                  </span>
                </div>
              ))}
              <div className="flex justify-between border-t border-border pt-2 font-medium">
                <span>Cut time, about</span>
                <span className="tabular-nums" data-testid="cad-cam-total">
                  {formatMinutes(plan.minutes)}
                </span>
              </div>
              {plan.warnings.map((warning) => (
                <p key={warning} className="text-xs text-warning">
                  {warning}
                </p>
              ))}
              <p className="pt-1 text-xs text-muted-foreground">
                Preview only: CADsense plans the cut and exports the DXF; post the G-code in your
                router's CAM program.
              </p>
            </div>
          </>
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center text-sm text-muted-foreground">
            Planning…
          </div>
        )}
        {parts.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto border-t border-border px-3 py-2">
            {parts.map((part, i) => (
              <button
                key={part.geometryKey}
                type="button"
                onClick={() => setIndex(i)}
                className={cn(
                  "shrink-0 rounded-md border px-2 py-1 text-xs",
                  i === index
                    ? "border-ring bg-accent"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {part.qty}× {part.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Tool paths over the plate, with a scrubber that replays the cut in operation order. */
const Preview = ({
  plate,
  operations,
  tool,
}: {
  plate: PlateGeometry;
  operations: readonly CamOperation[];
  tool: number;
}) => {
  const margin = 0.35;
  const [progress, setProgress] = useState(1);
  const frame = useRef(0);
  // Every path once, in cut order, with its running length for the replay.
  const steps = useMemo(() => {
    let total = 0;
    const out: { op: CamOperation; path: readonly Vec2[]; from: number; length: number }[] = [];
    for (const op of operations)
      for (const path of op.paths) {
        const length = path.reduce(
          (sum, p, i) =>
            sum +
            Math.hypot(
              path[(i + 1) % path.length]![0] - p[0],
              path[(i + 1) % path.length]![1] - p[1],
            ),
          0,
        );
        out.push({ op, path, from: total, length });
        total += length + 0.5; // a short rapid between paths keeps plunges readable
      }
    return { out, total };
  }, [operations]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const play = () => {
    cancelAnimationFrame(frame.current);
    const started = performance.now();
    const duration = Math.min(14_000, Math.max(5_000, steps.total * 25));
    const tick = () => {
      const p = Math.min(1, (performance.now() - started) / duration);
      setProgress(p);
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };
    tick();
  };
  const at = progress * steps.total;
  const current = steps.out.find((step) => at >= step.from && at <= step.from + step.length);
  const toolPoint = current ? pointAlong(current.path, at - current.from) : null;
  const d = (path: readonly Vec2[]) =>
    `M${path.map(([x, y]) => `${x.toFixed(4)} ${(-y).toFixed(4)}`).join("L")}Z`;
  const featurePaths = plate.features.map((feature, i) =>
    feature.kind === "hole" ? (
      <circle key={i} cx={feature.center[0]} cy={-feature.center[1]} r={feature.diameter / 2} />
    ) : (
      <path key={i} d={d(feature.polygon)} />
    ),
  );
  return (
    <div className="border-b border-border bg-[var(--cad-viewport-background)] p-3">
      <svg
        className="w-full"
        viewBox={`${-margin} ${-plate.height - margin} ${plate.width + 2 * margin} ${plate.height + 2 * margin}`}
        style={{
          aspectRatio: `${plate.width + 2 * margin} / ${plate.height + 2 * margin}`,
          maxHeight: 520,
        }}
        data-testid="cad-cam-preview"
      >
        <rect
          x={-margin * 0.6}
          y={-plate.height - margin * 0.6}
          width={plate.width + margin * 1.2}
          height={plate.height + margin * 1.2}
          fill="#24282b"
          rx={0.04}
        />
        <path d={d(plate.outline)} fill="#3a4045" stroke="#c9cdd1" strokeWidth={0.012} />
        <g fill="#24282b" stroke="#c9cdd1" strokeWidth={0.008}>
          {featurePaths}
        </g>
        {steps.out.map((step, i) => {
          const done = at >= step.from + step.length;
          const active = step === current;
          return (
            <path
              key={i}
              d={d(step.path)}
              fill="none"
              stroke={OP_COLOR[step.op.kind]}
              strokeWidth={step.op.kind === "pocket" ? 0.012 : 0.018}
              strokeLinejoin="round"
              opacity={done || active ? 0.95 : 0.18}
              strokeDasharray={active ? `${at - step.from} ${step.length}` : undefined}
            />
          );
        })}
        {operations
          .filter((op) => op.kind === "profile")
          .flatMap((op) => op.tabs)
          .map(([x, y], i) => (
            <rect
              key={`tab${i}`}
              x={x - 0.09}
              y={-y - 0.09}
              width={0.18}
              height={0.18}
              fill="#ffffff"
              stroke="#111"
              strokeWidth={0.01}
              rx={0.02}
            />
          ))}
        {toolPoint && progress < 1 && (
          <circle
            cx={toolPoint[0]}
            cy={-toolPoint[1]}
            r={tool / 2}
            fill="rgba(255,255,255,0.85)"
            stroke="#111"
            strokeWidth={0.01}
          />
        )}
      </svg>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Simulate the cut" onClick={play}>
          <PlayIcon />
        </Button>
        <input
          aria-label="Cut progress"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={progress}
          onChange={(e) => {
            cancelAnimationFrame(frame.current);
            setProgress(Number(e.target.value));
          }}
          className="flex-1"
        />
        <span className="w-28 truncate text-right text-xs text-muted-foreground">
          {current ? current.op.label : progress >= 1 ? "Done" : ""}
        </span>
      </div>
    </div>
  );
};

const pointAlong = (path: readonly Vec2[], distance: number): Vec2 => {
  let left = distance;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= step)
      return step === 0
        ? a
        : [a[0] + ((b[0] - a[0]) * left) / step, a[1] + ((b[1] - a[1]) * left) / step];
    left -= step;
  }
  return path[0]!;
};

const formatMinutes = (minutes: number) =>
  minutes < 1 ? `${Math.max(1, Math.round(minutes * 60))} s` : `${minutes.toFixed(1)} min`;

const inputClass =
  "rounded-md border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring";

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-muted-foreground">{label}</span>
    {children}
  </label>
);

const NumberInput = ({
  value,
  step,
  min = step,
  onChange,
  suffix,
}: {
  value: number;
  step: number;
  /** Smallest accepted value; depths and feeds must stay positive. */
  min?: number;
  onChange: (value: number) => void;
  suffix?: string;
}) => (
  <span className="flex items-center gap-1">
    <input
      className={cn(inputClass, "w-20 tabular-nums")}
      type="number"
      step={step}
      min={min}
      value={value}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next) && next >= min) onChange(next);
      }}
    />
    {suffix && <span className="text-muted-foreground">{suffix}</span>}
  </span>
);
