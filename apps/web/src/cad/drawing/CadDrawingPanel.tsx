// The right panel's Part drawing section: print-ready sheets for the parts in a
// `RightPanelDrawing`, built in the browser from the snapshot's cached part meshes. A group
// selection keeps only parts the shop draws; plates and printed parts are counted, not drawn.
import { useAtomValue } from "@effect/atom-react";
import { CadSnapshotManifest, type ScopedThreadRef } from "@cadsense/contracts";
import { CaretLeftIcon, CaretRightIcon, PrinterIcon } from "~/lib/icons";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import type { RightPanelDrawing } from "../../rightPanelStore";
import { cadPanelEnvironment } from "../../state/cadPanel";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import {
  analyzePart,
  projectView,
  viewSpecs,
  type DrawingView,
  type PartAnalysis,
} from "./analysis";
import {
  glbExtents,
  resolveDrawingSheets,
  shopRoute,
  type DrawingSheetEntry,
  type ShopRoute,
} from "./drawingModel";
import { loadGlbPart } from "./loadPart";
import { SHEET_H, SHEET_W } from "./sheetKit";
import { VARIANTS, describePart, type SheetData, type VariantKey } from "./sheets";
import {
  holeReadings,
  operationsFor,
  stockFor,
  type HoleReading,
  type Units,
} from "./shopKnowledge";

const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const MAX_TRIANGLES = 150_000;
const SHEET_STYLE = {
  "--sheet-font": '"Inter", "Helvetica Neue", Arial, sans-serif',
} as CSSProperties;

interface Prepared {
  readonly part: PartAnalysis;
  readonly views: Record<"front" | "top" | "right" | "iso", DrawingView>;
}

// Parts keep their bytes and analysis for the session; the same mesh always draws the same way.
const assetBySha = new Map<string, Promise<ArrayBuffer>>();
const preparedBySha = new Map<string, Promise<Prepared>>();

const prepare = (sha256: string, fetchAsset: (sha256: string) => Promise<ArrayBuffer>) => {
  const cached = preparedBySha.get(sha256);
  if (cached) return cached;
  const work = fetchAsset(sha256)
    .then(loadGlbPart)
    .then((mesh) => {
      const part = analyzePart(mesh);
      const specs = viewSpecs(part.frame);
      return {
        part,
        views: {
          front: projectView(part, specs.front),
          top: projectView(part, specs.top),
          right: projectView(part, specs.right),
          iso: projectView(part, specs.iso),
        },
      };
    });
  work.catch(() => preparedBySha.delete(sha256));
  preparedBySha.set(sha256, work);
  return work;
};

interface SheetForm {
  requester: string;
  team: string;
  due: string;
  notes: string;
}

/** Per-part choices: quantity, material, and how each hole group reads. */
interface PartChoices {
  qty?: number;
  material?: string;
  readings: Record<string, string>;
}

const buildSheet = (
  entry: DrawingSheetEntry,
  prepared: Prepared,
  form: SheetForm,
  choices: PartChoices | undefined,
  units: Units,
  revision: string,
): SheetData => {
  const readings = new Map<string, HoleReading>();
  for (const group of prepared.part.holes) {
    const options = holeReadings(group, prepared.part);
    readings.set(
      group.key,
      options.find((option) => option.id === choices?.readings[group.key]) ?? options[0]!,
    );
  }
  const material = choices?.material ?? (entry.material || "Aluminum 6061");
  return {
    part: prepared.part,
    views: prepared.views,
    name: entry.name,
    description: describePart(prepared.part, readings, units),
    qty: choices?.qty ?? entry.qty,
    material,
    ...form,
    units,
    readings,
    stock: stockFor(prepared.part, material),
    operations: operationsFor(prepared.part, material, readings),
    source: { partId: entry.partId, revision, date: new Date().toISOString().slice(0, 10) },
  };
};

export function CadDrawingPanel({
  threadRef,
  drawing,
}: {
  threadRef: ScopedThreadRef;
  drawing: RightPanelDrawing;
}) {
  const sceneAtom = cadPanelEnvironment.scene({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, snapshotId: drawing.snapshotId },
  });
  // Mounting the lease keeps the scene ticket alive while the drawing is open.
  const lease = useAtomValue(sceneAtom);
  const ticket = AsyncResult.isSuccess(lease) ? lease.value : null;
  const baseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const [manifest, setManifest] = useState<CadSnapshotManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [variant, setVariant] = useState<VariantKey>("A");
  const [units, setUnits] = useState<Units>("in");
  const [form, setForm] = useState<SheetForm>({ requester: "", team: "", due: "", notes: "" });
  const [choices, setChoices] = useState<Record<string, PartChoices>>({});
  const [prepared, setPrepared] = useState<Record<string, Prepared>>({});
  const [printing, setPrinting] = useState<SheetData[] | null>(null);
  const printRoot = useRef<HTMLDivElement>(null);

  const fetchFromScene = useMemo(() => {
    if (!ticket || !baseUrl) return null;
    return async (path: string) => {
      const response = await fetch(
        new URL(
          `api/cad-panel/${ticket.sceneId}${path}`,
          baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
        ),
        {
          credentials: "omit",
          headers: { "x-cad-panel-token": ticket.token },
        },
      );
      if (!response.ok) throw new Error("CAD scene unavailable");
      return response;
    };
  }, [ticket, baseUrl]);
  const fetchAsset = useMemo(() => {
    if (!fetchFromScene) return null;
    return (sha256: string) => {
      const cached = assetBySha.get(sha256);
      if (cached) return cached;
      const bytes = fetchFromScene(`/${sha256}`).then((response) => response.arrayBuffer());
      bytes.catch(() => assetBySha.delete(sha256));
      assetBySha.set(sha256, bytes);
      return bytes;
    };
  }, [fetchFromScene]);
  const [routes, setRoutes] = useState<Record<string, ShopRoute> | null>(null);

  useEffect(() => {
    if (!fetchFromScene || manifest) return;
    let live = true;
    fetchFromScene("?delivery=meshopt-bin-v1")
      .then((response) => response.json())
      .then((json) => live && setManifest(decodeManifest(json)))
      .catch((cause: unknown) => live && setError(String(cause)));
    return () => {
      live = false;
    };
  }, [fetchFromScene, manifest]);

  const candidates = useMemo(
    () => (manifest ? resolveDrawingSheets(manifest, drawing.occurrenceIds) : []),
    [manifest, drawing.occurrenceIds],
  );
  // A group draws only what the shop draws; a part the user picked is drawn whatever it is.
  const isGroup = useMemo(
    () =>
      !!manifest &&
      drawing.occurrenceIds.some(
        (id) => manifest.nodes.find((node) => node.id === id)?.kind !== "part",
      ),
    [manifest, drawing.occurrenceIds],
  );
  useEffect(() => {
    if (!isGroup || !fetchAsset || candidates.length === 0) return;
    let live = true;
    Promise.all(
      candidates.map(async (candidate) => {
        const extents = glbExtents(new Uint8Array(await fetchAsset(candidate.sha256)));
        return [candidate.sha256, shopRoute(candidate.material, extents)] as const;
      }),
    )
      .then((entries) => live && setRoutes(Object.fromEntries(entries)))
      .catch((cause: unknown) => live && setError(String(cause)));
    return () => {
      live = false;
    };
  }, [isGroup, fetchAsset, candidates]);
  const sheets = useMemo(
    () =>
      isGroup
        ? candidates.filter((candidate) => routes?.[candidate.sha256] === "drawing")
        : candidates,
    [isGroup, candidates, routes],
  );
  const skipped = useMemo(() => {
    const count = (route: ShopRoute) =>
      candidates
        .filter((candidate) => routes?.[candidate.sha256] === route)
        .reduce((sum, candidate) => sum + candidate.qty, 0);
    return isGroup && routes ? { cnc: count("cnc"), print: count("print") } : null;
  }, [isGroup, candidates, routes]);
  const entry = sheets[Math.min(index, Math.max(0, sheets.length - 1))] ?? null;
  const ready = entry ? prepared[entry.sha256] : undefined;

  useEffect(() => {
    if (!entry || !fetchAsset || prepared[entry.sha256] || entry.triangles > MAX_TRIANGLES) return;
    let live = true;
    // Let the "Drawing" state paint before the main thread is busy.
    const timer = setTimeout(() => {
      prepare(entry.sha256, fetchAsset)
        .then((value) => live && setPrepared((current) => ({ ...current, [entry.sha256]: value })))
        .catch((cause: unknown) => live && setError(String(cause)));
    }, 30);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [entry, fetchAsset, prepared]);

  const revision = manifest?.root.microversionId.slice(0, 8) ?? "";
  const data =
    entry && ready
      ? buildSheet(entry, ready, form, choices[entry.geometryKey], units, revision)
      : null;
  const current = VARIANTS.find((v) => v.key === variant)!;

  const printAll = async () => {
    if (!fetchAsset) return;
    const all = await Promise.all(
      sheets
        .filter((sheet) => sheet.triangles <= MAX_TRIANGLES)
        .map(async (sheet) =>
          buildSheet(
            sheet,
            await prepare(sheet.sha256, fetchAsset),
            form,
            choices[sheet.geometryKey],
            units,
            revision,
          ),
        ),
    );
    setPrinting(all);
  };

  // Print from a detached frame so only the sheets reach the printer.
  useEffect(() => {
    if (!printing || !printRoot.current) return;
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(
      `<!doctype html><html><head><style>@page{size:letter landscape;margin:0}body{margin:0}svg{display:block;width:11in;height:8.5in;page-break-after:always}</style></head><body>${printRoot.current.innerHTML}</body></html>`,
    );
    doc.close();
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 1000);
    setPrinting(null);
  }, [printing]);

  const updateChoices = (key: string, update: (current: PartChoices) => PartChoices) =>
    setChoices((all) => ({ ...all, [key]: update(all[key] ?? { readings: {} }) }));

  if (error)
    return <div className="p-4 text-sm text-destructive">Could not draw this part: {error}</div>;
  if (!manifest || (isGroup && !routes))
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {manifest ? "Sorting the parts…" : "Loading the model…"}
      </div>
    );
  if (sheets.length === 0)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Nothing in {drawing.title} needs a drawing. {skippedText(skipped)}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cad-drawing-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{entry?.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {sheets.length > 1
              ? `${drawing.title} · sheet ${index + 1} of ${sheets.length}`
              : `${entry?.qty}× in the assembly`}
          </div>
        </div>
        {sheets.length > 1 && (
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous sheet"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <CaretLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next sheet"
              disabled={index >= sheets.length - 1}
              onClick={() => setIndex(index + 1)}
            >
              <CaretRightIcon />
            </Button>
          </div>
        )}
        <Segmented
          label="Sheet style"
          value={variant}
          options={VARIANTS.map((v) => ({ value: v.key, label: v.name }))}
          onChange={setVariant}
        />
        <Segmented
          label="Units"
          value={units}
          options={[
            { value: "in", label: "in" },
            { value: "mm", label: "mm" },
          ]}
          onChange={setUnits}
        />
        <Button variant="outline" size="sm" disabled={!data} onClick={() => void printAll()}>
          <PrinterIcon />
          {sheets.length > 1 ? `Print ${sheets.length}` : "Print"}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="bg-[var(--cad-viewport-background)] p-3">
          {data ? (
            <svg
              className="aspect-[11/8.5] w-full bg-white shadow-lg"
              viewBox={`0 0 ${SHEET_W} ${SHEET_H}`}
              style={SHEET_STYLE}
              data-testid="cad-drawing-sheet"
            >
              <current.Sheet data={data} />
            </svg>
          ) : (
            <div className="flex aspect-[11/8.5] w-full items-center justify-center text-sm text-muted-foreground">
              {entry && entry.triangles > MAX_TRIANGLES
                ? "This part is too detailed to draw yet."
                : "Drawing…"}
            </div>
          )}
        </div>

        {sheets.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
            {sheets.map((sheet, i) => (
              <button
                key={sheet.geometryKey}
                type="button"
                onClick={() => setIndex(i)}
                className={cn(
                  "shrink-0 rounded-md border px-2 py-1 text-xs",
                  i === index
                    ? "border-ring bg-accent"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {sheet.qty}× {sheet.name}
              </button>
            ))}
          </div>
        )}
        {skippedText(skipped) && (
          <p
            className="border-b border-border px-3 py-2 text-xs text-muted-foreground"
            data-testid="cad-drawing-skipped"
          >
            Not drawn: {skippedText(skipped)}
          </p>
        )}

        {entry && data && ready && (
          <div className="grid gap-x-3 gap-y-2 px-3 py-3 text-[13px] sm:grid-cols-2">
            <Field label="Requested by">
              <input
                className={inputClass}
                value={form.requester}
                onChange={(e) => setForm({ ...form, requester: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Team">
                <input
                  className={inputClass}
                  value={form.team}
                  onChange={(e) => setForm({ ...form, team: e.target.value })}
                />
              </Field>
              <Field label="Due">
                <input
                  className={inputClass}
                  value={form.due}
                  onChange={(e) => setForm({ ...form, due: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Qty">
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  value={data.qty}
                  onChange={(e) =>
                    updateChoices(entry.geometryKey, (c) => ({
                      ...c,
                      qty: Math.max(1, Number(e.target.value) || 1),
                    }))
                  }
                />
              </Field>
              <Field label="Material">
                <input
                  className={inputClass}
                  value={data.material}
                  onChange={(e) =>
                    updateChoices(entry.geometryKey, (c) => ({ ...c, material: e.target.value }))
                  }
                />
              </Field>
            </div>
            <Field label="Note for the shop">
              <input
                className={inputClass}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Field>
            {ready.part.holes.map((group) => {
              const options = holeReadings(group, ready.part);
              const confirmed = group.key in (choices[entry.geometryKey]?.readings ?? {});
              return (
                <Field
                  key={group.key}
                  label={`${group.holes.length}× Ø${(group.diameter / 0.0254).toFixed(3)} ${group.depth === null ? "through" : `${(group.depth / 0.0254).toFixed(2)} deep`}${group.bothEnds ? ", both ends" : ""}`}
                >
                  <select
                    className={inputClass}
                    aria-label="Hole reading"
                    value={data.readings.get(group.key)?.id}
                    onChange={(e) =>
                      updateChoices(entry.geometryKey, (c) => ({
                        ...c,
                        readings: { ...c.readings, [group.key]: e.target.value },
                      }))
                    }
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {!confirmed && options.length > 1 && (
                    <span className="mt-1 block text-xs text-warning">
                      Guessed from the diameter. Confirm before printing.
                    </span>
                  )}
                </Field>
              );
            })}
          </div>
        )}
      </div>

      {printing && (
        <div
          ref={printRoot}
          aria-hidden
          className="pointer-events-none fixed -left-[20000px] top-0 w-[1100px]"
        >
          {printing.map((sheet, i) => (
            <svg
              key={i}
              viewBox={`0 0 ${SHEET_W} ${SHEET_H}`}
              style={SHEET_STYLE}
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width={SHEET_W} height={SHEET_H} fill="white" />
              <current.Sheet data={sheet} />
            </svg>
          ))}
        </div>
      )}
    </div>
  );
}

/** "3 plates go to the router and 14 printed parts to the printer." for a group's skipped parts. */
const skippedText = (skipped: { cnc: number; print: number } | null) => {
  if (!skipped || skipped.cnc + skipped.print === 0) return "";
  const parts = [
    skipped.cnc
      ? `${skipped.cnc} ${skipped.cnc === 1 ? "plate goes" : "plates go"} to the router`
      : null,
    skipped.print
      ? `${skipped.print} printed ${skipped.print === 1 ? "part goes" : "parts go"} to the printer`
      : null,
  ].filter(Boolean);
  return `${parts.join(" and ")}.`;
};

const inputClass =
  "w-full rounded-md border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring";

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="mb-1 block truncate text-xs text-muted-foreground">{label}</span>
    {children}
  </label>
);

const Segmented = <T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) => (
  <div
    role="radiogroup"
    aria-label={label}
    className="flex overflow-hidden rounded-md border border-border text-xs"
  >
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={value === option.value}
        onClick={() => onChange(option.value)}
        className={cn(
          "px-2 py-1",
          value === option.value
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);
