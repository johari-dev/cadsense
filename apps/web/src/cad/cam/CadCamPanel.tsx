// The right panel's CAM section: a router plan for plates. A setup row, the plate with its tool
// paths, a timeline that replays the cut by operation, and the operations table. A group keeps
// only its plates. Send to Fusion builds the same operations there, where the team posts G-code.
import type { ScopedThreadRef } from "@cadsense/contracts";
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, PauseIcon, PlayIcon } from "~/lib/icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { useRightPanelStore, type RightPanelDrawing } from "../../rightPanelStore";
import { MAX_ANALYZED_TRIANGLES, type PartAnalysis, type Vec2 } from "../drawing/analysis";
import { resolveDrawingSheets } from "../drawing/drawingModel";
import { routeCounts, useCadSnapshotAssets, useShopRoutes } from "../useCadSnapshotAssets";
import { downloadText, plateDxf } from "./dxf";
import { sendPlateToFusion, type FusionPlateResult } from "./fusion";
import { plateGeometry, type PlateGeometry } from "./plateGeometry";
import {
  DEFAULT_CAM,
  fraction,
  planPlate,
  type CamOperation,
  type CamPlan,
  type CamSettings,
} from "./toolpaths";

const TOOLS = [0.125, 0.1575, 0.1875, 0.25] as const; // 1/8", 4 mm, 3/16", 1/4"
// The 3D viewer's highlight, so a selected operation reads the same as a highlighted part.
const HIGHLIGHT = "#ffbf36";

type PlateState = PlateGeometry | "not-a-plate" | "too-detailed" | { readonly error: string };
/** A part's plate geometry, or why there is none. */
const readPlate = (
  part: { readonly sha256: string; readonly triangles: number },
  analyze: (sha256: string) => Promise<PartAnalysis>,
): Promise<PlateState> =>
  part.triangles > MAX_ANALYZED_TRIANGLES
    ? Promise.resolve("too-detailed")
    : analyze(part.sha256)
        .then((analysis) => plateGeometry(analysis) ?? ("not-a-plate" as const))
        .catch((cause: unknown) => ({ error: String(cause) }));

type FusionState =
  | { readonly status: "sending" }
  | { readonly status: "sent"; readonly result: FusionPlateResult }
  | { readonly status: "failed"; readonly error: string };

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
  // Per plate: its geometry, or why there is none. One bad mesh must not hide the other plates.
  const [plates, setPlates] = useState<Record<string, PlateState>>({});
  // Per plate: its last send to Fusion. Kept across settings changes; sending again replaces it.
  const [fusion, setFusion] = useState<Record<string, FusionState>>({});

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
      isGroup
        ? candidates.filter(
            (candidate) => candidate.named || routes?.[candidate.geometryKey] === "cnc",
          )
        : candidates,
    [isGroup, candidates, routes],
  );
  const entry = parts[Math.min(index, Math.max(0, parts.length - 1))] ?? null;
  const plate = entry ? plates[entry.sha256] : undefined;
  const ready = plate && typeof plate === "object" && "outline" in plate ? plate : null;
  const plan = useMemo(() => (ready ? planPlate(ready, settings) : null), [ready, settings]);
  const sent = entry ? fusion[entry.sha256] : undefined;
  const sending = Object.values(fusion).some((state) => state.status === "sending");

  useEffect(() => {
    if (!entry || !analyze || plates[entry.sha256]) return;
    const sha256 = entry.sha256;
    let live = true;
    void readPlate(entry, analyze).then(
      (result) => live && setPlates((current) => ({ ...current, [sha256]: result })),
    );
    return () => {
      live = false;
    };
  }, [entry, analyze, plates]);

  // Sends plates one at a time, so Fusion builds one document before starting the next. A part
  // that is not a plate fails on its own; the rest still go.
  const sendToFusion = async (targets: readonly (typeof parts)[number][]) => {
    for (const part of targets) {
      setFusion((current) => ({ ...current, [part.sha256]: { status: "sending" } }));
      const geometry =
        plates[part.sha256] ??
        (analyze ? await readPlate(part, analyze) : { error: "The model is still loading." });
      setPlates((current) => ({ ...current, [part.sha256]: geometry }));
      const next: FusionState =
        typeof geometry === "object" && "outline" in geometry
          ? await sendPlateToFusion({
              key: part.sha256,
              name: part.name,
              plate: geometry,
              settings,
            })
              .then((result) => ({ status: "sent" as const, result }))
              .catch((cause: unknown) => ({
                status: "failed" as const,
                error: cause instanceof Error ? cause.message : String(cause),
              }))
          : { status: "failed", error: "Not a plate the router can cut." };
      setFusion((current) => ({ ...current, [part.sha256]: next }));
    }
  };

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
        <p>No plates in {cam.title}.</p>
        {counts?.drawing ? (
          <Button size="sm" variant="outline" onClick={openDrawing}>
            Make shop drawings for its {counts.drawing} parts
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cad-cam-panel">
      <div className="flex shrink-0 items-center gap-3 px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{entry?.name}</div>
          <div className="truncate font-mono text-[11.5px] text-muted-foreground tabular-nums">
            {ready
              ? `${entry?.material ? `${entry.material} · ` : ""}${ready.thickness.toFixed(3)} × ${ready.width.toFixed(2)} × ${ready.height.toFixed(2)} in · qty ${entry?.qty}`
              : `qty ${entry?.qty}`}
          </div>
        </div>
        {parts.length > 1 && (
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous plate"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <CaretLeftIcon />
            </Button>
            {index + 1}/{parts.length}
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
          size="sm"
          variant="outline"
          disabled={!ready}
          onClick={() =>
            ready &&
            entry &&
            downloadText(`${entry.name.replace(/[^\w.-]+/g, "_")}.dxf`, plateDxf(ready))
          }
        >
          Export DXF
        </Button>
        {parts.length > 1 ? (
          <Menu>
            <MenuTrigger render={<Button size="sm" disabled={sending} />}>
              {sending ? "Sending…" : "Send to Fusion"}
              <CaretDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={!ready} onClick={() => entry && void sendToFusion([entry])}>
                This plate
              </MenuItem>
              <MenuItem onClick={() => void sendToFusion(parts)}>
                All {parts.length} plates
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : (
          <Button
            size="sm"
            disabled={!ready || sending}
            onClick={() => entry && void sendToFusion([entry])}
          >
            {sending ? "Sending…" : "Send to Fusion"}
          </Button>
        )}
      </div>
      {sent && <FusionStatus state={sent} />}

      <div className="flex shrink-0 flex-wrap gap-2.5 border-b border-border px-3.5 pb-3">
        <Field label="Tool">
          <select
            aria-label="Tool diameter"
            className={cn(inputClass, "pr-1")}
            value={settings.tool}
            onChange={(e) => setSettings({ ...settings, tool: Number(e.target.value) })}
          >
            {TOOLS.map((tool) => (
              <option key={tool} value={tool}>
                {tool === 0.1575 ? "4 mm" : fraction(tool)} flat
              </option>
            ))}
          </select>
        </Field>
        <Field label="DOC">
          <NumberInput
            label="Depth of cut"
            value={settings.stepdown}
            step={0.005}
            onChange={(stepdown) => setSettings({ ...settings, stepdown })}
          />
        </Field>
        <Field label="Feed">
          <NumberInput
            label="Feed"
            value={settings.feed}
            step={5}
            unit="ipm"
            onChange={(feed) => setSettings({ ...settings, feed })}
          />
        </Field>
        <Field label="Plunge">
          <NumberInput
            label="Plunge"
            value={settings.plunge}
            step={5}
            unit="ipm"
            onChange={(plunge) => setSettings({ ...settings, plunge })}
          />
        </Field>
        <Field label="Tabs">
          <NumberInput
            label="Tabs"
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
            <p>Not a flat plate, so the router can't cut it.</p>
            <Button size="sm" variant="outline" onClick={openDrawing}>
              Make part drawing
            </Button>
          </div>
        ) : plate === "too-detailed" ? (
          <p className="p-4 text-sm text-muted-foreground">
            This plate is too detailed to plan yet.
          </p>
        ) : plate && "error" in plate ? (
          <p className="p-4 text-sm text-destructive">Could not read this plate: {plate.error}</p>
        ) : ready && plan ? (
          // Settings change the operations, so a new plan starts with no selection or playback.
          <CutPlan
            key={`${entry?.sha256}:${JSON.stringify(settings)}`}
            plate={ready}
            plan={plan}
            tool={settings.tool}
          />
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center text-sm text-muted-foreground">
            Planning…
          </div>
        )}
        {parts.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto border-t border-border px-3.5 py-2">
            {parts.map((part, i) => (
              <button
                key={part.geometryKey}
                type="button"
                onClick={() => setIndex(i)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                  i === index
                    ? "border-ring bg-accent"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {fusion[part.sha256] && <FusionDot state={fusion[part.sha256]!} />}
                {part.qty}× {part.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What Fusion made of the plate: its machining time, and every operation it could not generate
 * cleanly, with the reason.
 */
const FusionStatus = ({ state }: { state: FusionState }) => {
  if (state.status === "sending")
    return (
      <p className="shrink-0 px-3.5 pb-2.5 text-xs text-muted-foreground">Building in Fusion…</p>
    );
  if (state.status === "failed")
    return (
      <p role="alert" className="shrink-0 px-3.5 pb-2.5 text-xs text-destructive">
        {state.error}
      </p>
    );
  const { result } = state;
  const problems = result.operations.filter((op) => op.state !== "ok");
  return (
    <div className="shrink-0 space-y-1 px-3.5 pb-2.5 text-xs" data-testid="cad-cam-fusion">
      <p className="text-muted-foreground">
        {result.replaced ? "Rebuilt in Fusion" : "In Fusion"} · {result.operations.length}{" "}
        operations ·{" "}
        <span className="font-mono text-foreground tabular-nums">{clock(result.minutes)}</span>{" "}
        machining
        {problems.length === 0 && " · ready to post"}
      </p>
      {problems.map((op) => (
        <p key={op.name} className={op.state === "error" ? "text-destructive" : "text-warning"}>
          {op.name}: {op.message ?? (op.state === "error" ? "failed to generate" : "has warnings")}
        </p>
      ))}
    </div>
  );
};

/** A plate chip's Fusion state: sending, generated cleanly, or needs a look. */
const FusionDot = ({ state }: { state: FusionState }) => (
  <span
    aria-hidden
    className={cn(
      "size-1.5 rounded-full",
      state.status === "sending"
        ? "bg-muted-foreground"
        : state.status === "failed" || state.result.operations.some((op) => op.state === "error")
          ? "bg-destructive"
          : state.result.operations.some((op) => op.state === "warning")
            ? "bg-warning"
            : "bg-success",
    )}
  />
);

/**
 * Preview, timeline, and operations table for one plan. They share one cursor: the selected or
 * hovered operation, or during playback the one being cut, draws in the highlight colour.
 */
const CutPlan = ({ plate, plan, tool }: { plate: PlateGeometry; plan: CamPlan; tool: number }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // Playback position in cut minutes; null shows the whole plan at rest.
  const [time, setTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const frame = useRef(0);
  const { operations } = plan;
  const starts = useMemo(() => {
    let at = 0;
    return operations.map((op) => {
      const start = at;
      at += op.minutes;
      return start;
    });
  }, [operations]);
  const total = plan.minutes;
  const current =
    time === null
      ? null
      : Math.max(
          0,
          starts.findLastIndex((start) => start <= Math.min(time, total - 1e-9)),
        );

  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const play = () => {
    cancelAnimationFrame(frame.current);
    if (playing) {
      setPlaying(false);
      return;
    }
    // A whole plan replays in 4 to 12 seconds, in proportion to its cut time.
    const seconds = Math.min(12, Math.max(4, total));
    const from = time !== null && time < total ? time : 0;
    const started = performance.now();
    setPlaying(true);
    const tick = () => {
      const next = from + ((performance.now() - started) / 1000 / seconds) * total;
      if (next >= total) {
        setTime(null);
        setPlaying(false);
        return;
      }
      setTime(next);
      frame.current = requestAnimationFrame(tick);
    };
    tick();
  };
  const scrub = (next: number) => {
    cancelAnimationFrame(frame.current);
    setPlaying(false);
    setTime(next);
  };
  const scrubAt = (event: { clientX: number; currentTarget: HTMLElement }) => {
    const box = event.currentTarget.getBoundingClientRect();
    scrub(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * total);
  };

  const focus = hovered ?? (time !== null ? current : selected);
  return (
    <>
      <PlatePreview
        plate={plate}
        operations={operations}
        tool={tool}
        focus={focus}
        progress={
          time === null || current === null
            ? null
            : { op: current, fraction: (time - starts[current]!) / operations[current]!.minutes }
        }
      />
      <div className="border-b border-border px-3.5 pt-2.5 pb-3">
        <div className="mb-2 flex items-center gap-2.5">
          <Button
            size="icon-sm"
            className="size-7 rounded-full"
            aria-label={playing ? "Pause the cut" : "Play the cut"}
            onClick={play}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <span className="font-mono text-[12.5px] tabular-nums">
            {clock(time ?? 0)} <span className="text-muted-foreground">/ {clock(total)}</span>
          </span>
        </div>
        <div
          role="slider"
          aria-label="Cut position"
          aria-valuemin={0}
          aria-valuemax={Math.round(total * 60)}
          aria-valuenow={Math.round((time ?? 0) * 60)}
          aria-valuetext={clock(time ?? 0)}
          tabIndex={0}
          className="relative flex h-8 cursor-ew-resize touch-none gap-0.5 overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            scrubAt(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubAt(event);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const step = (event.key === "ArrowRight" ? 1 : -1) * total * 0.02;
            scrub(Math.max(0, Math.min(total, (time ?? 0) + step)));
          }}
        >
          {operations.map((op, i) => {
            const state =
              time === null ? "rest" : i < current! ? "done" : i === current ? "now" : "todo";
            return (
              <Tooltip key={i}>
                <TooltipTrigger
                  render={
                    <div
                      onPointerEnter={() => setHovered(i)}
                      onPointerLeave={() => setHovered(null)}
                      className={cn(
                        "flex min-w-1.5 items-end overflow-hidden px-1.5 pb-1 text-left text-[11px] whitespace-nowrap",
                        state === "now"
                          ? "bg-[#ffbf36]/25 text-foreground"
                          : state === "done"
                            ? "bg-foreground/15 text-foreground"
                            : focus === i
                              ? "bg-foreground/12 text-foreground"
                              : "bg-foreground/6 text-muted-foreground",
                      )}
                      style={{ flexGrow: op.minutes, flexBasis: 0 }}
                    />
                  }
                >
                  <span className="truncate">
                    {op.name} <span className="font-mono opacity-60">{clock(op.minutes)}</span>
                  </span>
                </TooltipTrigger>
                <TooltipPopup>
                  {op.name}
                  {op.detail ? ` ${op.detail}` : ""} · {clock(op.minutes)}
                </TooltipPopup>
              </Tooltip>
            );
          })}
          {time !== null && (
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-foreground"
              style={{ left: `${(time / total) * 100}%` }}
            />
          )}
        </div>
      </div>

      <table className="w-full border-collapse text-[12.5px]" data-testid="cad-cam-operations">
        <thead>
          <tr className="text-[11.5px] text-muted-foreground">
            <th className="w-7" />
            <th className="py-2 pr-2.5 text-left font-medium">Operation</th>
            <th className="px-2.5 text-right font-medium">Qty</th>
            <th className="px-2.5 text-right font-medium">Depth</th>
            <th className="px-2.5 text-right font-medium">Passes</th>
            <th className="px-3.5 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {operations.map((op, i) => (
            <tr
              key={i}
              data-testid="cad-cam-operation"
              aria-selected={selected === i}
              onClick={() => {
                // Picking a row leaves playback so the selection shows on the whole plan.
                cancelAnimationFrame(frame.current);
                setPlaying(false);
                setTime(null);
                setSelected(selected === i ? null : i);
              }}
              onPointerEnter={() => setHovered(i)}
              onPointerLeave={() => setHovered(null)}
              className={cn(
                "cursor-default border-t border-border/60",
                focus === i ? "bg-[#ffbf36]/8" : "hover:bg-foreground/3",
              )}
            >
              <td
                className={cn(
                  "py-1.5 pl-3.5 text-muted-foreground",
                  focus === i && "shadow-[inset_2px_0_0_#ffbf36]",
                )}
              >
                {i + 1}
              </td>
              <td className="py-1.5 pr-2.5 font-sans">
                {op.name}
                {op.detail && <span className="text-muted-foreground"> {op.detail}</span>}
              </td>
              <td className="px-2.5 text-right">{op.count}</td>
              <td className="px-2.5 text-right">{op.depth.toFixed(3)}</td>
              <td className="px-2.5 text-right">{op.passes}</td>
              <td className="px-3.5 text-right">{clock(op.minutes)}</td>
            </tr>
          ))}
          {plan.drill.map((hole) => (
            <tr key={hole.diameter} className="border-t border-border/60 text-muted-foreground">
              <td className="py-1.5 pl-3.5">–</td>
              <td className="py-1.5 pr-2.5 font-sans">
                Drill by hand <span>Ø{hole.diameter.toFixed(3).replace(/^0/, "")}</span>
              </td>
              <td className="px-2.5 text-right">{hole.count}</td>
              <td className="px-2.5 text-right">thru</td>
              <td className="px-2.5 text-right" />
              <td className="px-3.5 text-right" />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border">
            <td />
            <td className="py-2 pr-2.5 text-muted-foreground">Total</td>
            <td colSpan={3} />
            <td
              className="px-3.5 text-right font-mono font-semibold tabular-nums"
              data-testid="cad-cam-total"
            >
              {clock(total)}
            </td>
          </tr>
        </tfoot>
      </table>
      {plan.warnings.length > 0 && (
        <ul className="space-y-1 px-3.5 pb-3 text-xs text-warning">
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  );
};

/**
 * The plate and its tool paths. With a focus the paths are neutral and the focused operation is
 * highlighted; during playback, finished operations are bright, the current one draws up to the
 * tool, and the rest are faint.
 */
const PlatePreview = ({
  plate,
  operations,
  tool,
  focus,
  progress,
}: {
  plate: PlateGeometry;
  operations: readonly CamOperation[];
  tool: number;
  focus: number | null;
  progress: { op: number; fraction: number } | null;
}) => {
  const margin = 0.35;
  const lengths = useMemo(() => operations.map((op) => op.paths.map(pathLength)), [operations]);
  // Playback re-renders every frame; the path strings only change with the plan.
  const pathData = useMemo(() => operations.map((op) => op.paths.map(svgPath)), [operations]);

  // During playback: how far along the current operation's paths the tool has travelled.
  let toolPoint: Vec2 | null = null;
  let cutTo = 0;
  if (progress) {
    const opLengths = lengths[progress.op]!;
    cutTo = progress.fraction * opLengths.reduce((sum, length) => sum + length, 0);
    let left = cutTo;
    const paths = operations[progress.op]!.paths;
    for (let i = 0; i < paths.length; i++) {
      if (left <= opLengths[i]!) {
        toolPoint = pointAlong(paths[i]!, left);
        break;
      }
      left -= opLengths[i]!;
    }
  }

  return (
    <div className="bg-[var(--cad-viewport-background)] p-3">
      <svg
        className="w-full"
        viewBox={`${-margin} ${-plate.height - margin} ${plate.width + 2 * margin} ${plate.height + 2 * margin}`}
        style={{
          aspectRatio: `${plate.width + 2 * margin} / ${plate.height + 2 * margin}`,
          maxHeight: 440,
        }}
        data-testid="cad-cam-preview"
      >
        <path
          d={svgPath(plate.outline)}
          fill="#1f2326"
          stroke="rgb(252 252 252 / 0.55)"
          strokeWidth={0.015}
        />
        <g fill="#111111" stroke="rgb(252 252 252 / 0.35)" strokeWidth={0.01}>
          {plate.features.map((feature, i) =>
            feature.kind === "hole" ? (
              <circle
                key={i}
                cx={feature.center[0]}
                cy={-feature.center[1]}
                r={feature.diameter / 2}
              />
            ) : (
              <path key={i} d={svgPath(feature.polygon)} />
            ),
          )}
        </g>
        {operations.map((op, i) => {
          let stroke = "#fcfcfc";
          let width = 0.015;
          let opacity = focus === null ? 0.7 : 0.35;
          if (progress) {
            if (i < progress.op) opacity = 0.85;
            else if (i > progress.op) opacity = 0.12;
            else [stroke, width, opacity] = [HIGHLIGHT, 0.03, 1];
          } else if (focus === i) [stroke, width, opacity] = [HIGHLIGHT, 0.03, 1];
          // The current operation is drawn only as far as the tool has gone.
          let budget = progress?.op === i ? cutTo : Infinity;
          return (
            <g key={i} fill="none" stroke={stroke} strokeWidth={width} opacity={opacity}>
              {pathData[i]!.map((data, k) => {
                const length = lengths[i]![k]!;
                const drawn = Math.max(0, Math.min(length, budget));
                budget -= length;
                if (budget + length <= 0 && progress?.op === i) return null;
                return (
                  <path
                    key={k}
                    d={data}
                    strokeLinejoin="round"
                    strokeDasharray={drawn < length ? `${drawn} ${length}` : undefined}
                  />
                );
              })}
              {op.tabs.map(([x, y], k) => (
                <rect
                  key={`tab${k}`}
                  x={x - 0.09}
                  y={-y - 0.09}
                  width={0.18}
                  height={0.18}
                  fill="#111111"
                />
              ))}
            </g>
          );
        })}
        {toolPoint && (
          <>
            <circle cx={toolPoint[0]} cy={-toolPoint[1]} r={tool / 2} fill="#fcfcfc" />
            <circle
              cx={toolPoint[0]}
              cy={-toolPoint[1]}
              r={tool * 1.3}
              fill="none"
              stroke="#fcfcfc"
              strokeWidth={0.012}
              opacity={0.6}
            />
          </>
        )}
      </svg>
    </div>
  );
};

/** A closed SVG path in plate inches, y flipped so the plate reads upright. */
const svgPath = (path: readonly Vec2[]) =>
  `M${path.map(([x, y]) => `${x.toFixed(4)} ${(-y).toFixed(4)}`).join("L")}Z`;

const pathLength = (path: readonly Vec2[]) =>
  path.reduce(
    (sum, p, i) =>
      sum +
      Math.hypot(path[(i + 1) % path.length]![0] - p[0], path[(i + 1) % path.length]![1] - p[1]),
    0,
  );

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

/** Minutes as m:ss. */
const clock = (minutes: number) => {
  const seconds = Math.round(minutes * 60);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const inputClass =
  "h-7 rounded-md border border-input bg-transparent px-2 text-[12.5px] outline-none focus:border-ring";

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
    {label}
    {children}
  </label>
);

const NumberInput = ({
  label,
  value,
  step,
  min = step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  /** Smallest accepted value; depths and feeds must stay positive. */
  min?: number;
  unit?: string;
  onChange: (value: number) => void;
}) => {
  // What is typed, so values on the way to a valid one ("", "1" on the way to "120") stay in the
  // field. Only valid values reach onChange; leaving the field shows the last valid value.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className={cn(inputClass, "flex w-[5.5rem] items-center gap-1 focus-within:border-ring")}>
      <input
        aria-label={label}
        className="w-full min-w-0 bg-transparent font-mono text-foreground tabular-nums outline-none"
        type="number"
        step={step}
        min={min}
        value={draft ?? value}
        onChange={(e) => {
          setDraft(e.target.value);
          const next = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(next) && next >= min) onChange(next);
        }}
        onBlur={() => setDraft(null)}
      />
      {unit && <span className="shrink-0 text-[11px] text-muted-foreground">{unit}</span>}
    </span>
  );
};
