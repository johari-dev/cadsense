import type { CadViewState } from "@cadsense/contracts";
import { useState } from "react";
import { Boxes } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

const presets = ["isometric", "front", "back", "left", "right", "top", "bottom"] as const;
type Preset = (typeof presets)[number];

// The PoC's face-highlighted cubes keep all seven views one click away.
function ViewCube({ view }: { view: Preset }) {
  const faces = [
    ["top", "M16 2.8 25.2 8.2 16 13.6 6.8 8.2Z"],
    ["front", "M6.8 9.7 16 15 16 26 6.8 20.5Z"],
    ["right", "M16 15 25.2 9.7 25.2 20.5 16 26Z"],
    ["left", "M4.9 10.8 6.8 9.7 6.8 20.5 4.9 19.4Z"],
    ["back", "M25.2 9.7 27.1 10.8 27.1 19.4 25.2 20.5Z"],
    ["bottom", "M6.8 20.5 16 26 25.2 20.5 25.2 22.6 16 28.2 6.8 22.6Z"],
  ] as const;
  return (
    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 32 32">
      {faces.map(([face, path]) => (
        <path
          key={face}
          d={path}
          strokeWidth="1.15"
          className={
            view === "isometric" || view === face
              ? "fill-red-500/85 stroke-red-300"
              : "fill-background stroke-current opacity-60"
          }
        />
      ))}
    </svg>
  );
}

export function CadCameraToolbar({
  view,
  disabled,
  onChange,
}: {
  view: CadViewState;
  disabled: boolean;
  onChange: (view: CadViewState) => void;
}) {
  const [sectionOpen, setSectionOpen] = useState(false);
  const sectionKey = JSON.stringify(view.sectionPlanes ?? []);
  const plane = view.sectionPlanes?.length === 1 ? view.sectionPlanes[0] : undefined;
  const axisIndex =
    plane?.normal.findIndex(
      (value, index, normal) => value === 1 && normal.every((v, i) => i === index || v === 0),
    ) ?? -1;
  const initialSection = {
    key: sectionKey,
    axis: axisIndex >= 0 ? ["x", "y", "z"][axisIndex]! : "z",
    offset: axisIndex >= 0 ? String(-plane!.constant) : "0",
  };
  const [draft, setDraft] = useState(initialSection);
  const section = draft.key === sectionKey ? draft : initialSection;
  if (draft.key !== sectionKey) setDraft(initialSection);
  const sectionAxis = section.axis;
  const sectionOffset = section.offset;
  const offset = Number(sectionOffset);
  const validOffset =
    sectionOffset.trim() !== "" && Number.isFinite(offset) && Math.abs(offset) <= 1e9;
  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-3 flex justify-center">
      <div
        role="toolbar"
        aria-label="CAD camera views"
        className="pointer-events-auto flex max-w-full flex-wrap justify-center gap-0.5 rounded-md border border-border/70 bg-background/90 p-1 shadow-lg"
      >
        {sectionOpen && (
          <form
            className="absolute bottom-full mb-2 flex flex-wrap items-center gap-2 rounded-md border bg-background p-3 text-xs"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !validOffset) return;
              const normal: [number, number, number] =
                sectionAxis === "x" ? [1, 0, 0] : sectionAxis === "y" ? [0, 1, 0] : [0, 0, 1];
              onChange({ ...view, sectionPlanes: [{ normal, constant: -offset }] });
            }}
          >
            <label>
              Keep axis ≥ offset{" "}
              <select
                aria-label="Section axis"
                value={sectionAxis}
                disabled={disabled}
                onChange={(event) => setDraft({ ...section, axis: event.target.value })}
              >
                <option value="x">X</option>
                <option value="y">Y</option>
                <option value="z">Z</option>
              </select>
            </label>
            <label>
              Offset (m){" "}
              <input
                aria-label="Section offset in meters"
                className="w-24 rounded border px-1"
                type="number"
                step="any"
                min={-1e9}
                max={1e9}
                value={sectionOffset}
                disabled={disabled}
                onChange={(event) => setDraft({ ...section, offset: event.target.value })}
              />
            </label>
            <Button size="sm" type="submit" disabled={disabled || !validOffset}>
              Apply section
            </Button>
            <p className="w-full text-muted-foreground">
              {view.sectionPlanes?.length && axisIndex < 0
                ? "Apply section replaces the current planes with the selected axis and offset."
                : "Uncapped section in displayed world coordinates."}
            </p>
          </form>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={sectionOpen}
          disabled={disabled}
          onClick={() => setSectionOpen(!sectionOpen)}
        >
          Section
        </Button>
        {presets.map((preset) => {
          const label = `${preset[0]!.toUpperCase()}${preset.slice(1)} CAD view`;
          return (
            <Tooltip key={preset}>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={label}
                    aria-pressed={view.camera.kind === "preset" && view.camera.preset === preset}
                    disabled={disabled}
                    variant="ghost"
                    size="icon-sm"
                    className="size-8 rounded-sm aria-pressed:bg-accent disabled:opacity-100"
                    onClick={() =>
                      onChange({ ...view, camera: { kind: "preset", preset, fit: [] } })
                    }
                  >
                    <ViewCube view={preset} />
                  </Button>
                }
              />
              <TooltipPopup>{label}</TooltipPopup>
            </Tooltip>
          );
        })}
        {view.highlightedOccurrenceIds?.length ||
        view.ghost?.occurrenceIds.length ||
        view.sectionPlanes?.length ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              onChange({ ...view, highlightedOccurrenceIds: [], ghost: null, sectionPlanes: [] })
            }
          >
            Reset inspection{view.sectionPlanes?.length ? " (section)" : ""}
          </Button>
        ) : null}
        <div className="mx-0.5 w-px self-stretch bg-border" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Exploded view"
                aria-pressed={view.explosion > 0}
                disabled={disabled}
                variant="ghost"
                size="icon-sm"
                className="size-8 rounded-sm aria-pressed:bg-accent disabled:opacity-100"
                onClick={() => onChange({ ...view, explosion: view.explosion > 0 ? 0 : 1 })}
              >
                <Boxes size={16} />
              </Button>
            }
          />
          <TooltipPopup>{view.explosion > 0 ? "Collapse CAD" : "Explode CAD"}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
