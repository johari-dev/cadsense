import type { CadViewState } from "@cadsense/contracts";
import { type RefObject, useState } from "react";
import { ArrowUUpLeftIcon, ScanIcon, StackIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { CadSceneRenderer } from "./CadSceneRenderer";
import { CadViewCube } from "./CadViewCube";

/** One toolbar button, filling the bar's height. Pressed (an applied section, exploded) is
    white; an open popover gets the hover background. */
const toolbarControl =
  "flex h-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 aria-expanded:bg-accent aria-expanded:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 data-active:bg-primary data-active:text-primary-foreground data-active:hover:bg-primary/90 [&_svg]:size-4 [&_svg]:shrink-0";
const sectionField =
  "h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 disabled:opacity-60";

function ToolbarDivider() {
  return <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

/** The viewport's bottom toolbar (fit, section, explode) and its bottom-right view cube. */
export function CadCameraToolbar({
  renderer,
  view,
  disabled,
  onChange,
}: {
  /** The live renderer the view cube turns with. Without it the cube shows the saved camera. */
  renderer?: RefObject<CadSceneRenderer | null>;
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
  const sectionApplied = (view.sectionPlanes?.length ?? 0) > 0;
  const inspecting =
    sectionApplied ||
    (view.highlightedOccurrenceIds?.length ?? 0) > 0 ||
    (view.ghost?.occurrenceIds.length ?? 0) > 0;
  return (
    <>
      {/* Bottom-right, clear of the parts chip, the comments card, and the toolbar. */}
      <div className="pointer-events-none absolute right-2 bottom-2 z-30">
        <CadViewCube renderer={renderer} view={view} disabled={disabled} onChange={onChange} />
      </div>
      {/* Above the comment marker layer (z-20) and opaque, so markers never show through it. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-3 z-30 flex justify-center">
        <div
          role="toolbar"
          aria-label="CAD camera views"
          className="pointer-events-auto relative flex h-(--cad-overlay-control) max-w-full items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-sm"
        >
          {sectionOpen && (
            <form
              aria-label="Section view"
              className="absolute bottom-full left-1/2 mb-2 flex w-72 -translate-x-1/2 flex-col gap-3 rounded-lg border bg-popover p-3 text-[13px] text-popover-foreground shadow-lg"
              onSubmit={(event) => {
                event.preventDefault();
                if (disabled || !validOffset) return;
                const normal: [number, number, number] =
                  sectionAxis === "x" ? [1, 0, 0] : sectionAxis === "y" ? [0, 1, 0] : [0, 0, 1];
                onChange({ ...view, sectionPlanes: [{ normal, constant: -offset }] });
              }}
            >
              <div className="flex flex-col gap-1">
                <p className="font-medium">Section view</p>
                <p className="text-xs text-muted-foreground">
                  Keeps the geometry where the axis is at or above the offset.
                </p>
              </div>
              <div className="grid grid-cols-[5rem_1fr] gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Axis
                  <select
                    aria-label="Section axis"
                    className={sectionField}
                    value={sectionAxis}
                    disabled={disabled}
                    onChange={(event) => setDraft({ ...section, axis: event.target.value })}
                  >
                    <option value="x">X</option>
                    <option value="y">Y</option>
                    <option value="z">Z</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Offset (m)
                  <input
                    aria-label="Section offset in meters"
                    className={cn(sectionField, "tabular-nums")}
                    type="number"
                    step="any"
                    min={-1e9}
                    max={1e9}
                    value={sectionOffset}
                    disabled={disabled}
                    onChange={(event) => setDraft({ ...section, offset: event.target.value })}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {view.sectionPlanes?.length && axisIndex < 0
                  ? "Apply section replaces the current planes with the selected axis and offset."
                  : "Uncapped section in displayed world coordinates."}
              </p>
              <Button size="sm" type="submit" disabled={disabled || !validOffset}>
                Apply section
              </Button>
            </form>
          )}
          <Tooltip>
            <TooltipTrigger
              aria-label="Fit to view"
              disabled={disabled}
              className={toolbarControl}
              onClick={() =>
                // A fit keeps the camera's direction and frames every shown part.
                onChange({
                  ...view,
                  camera:
                    view.camera.kind === "preset"
                      ? { ...view.camera, fit: [] }
                      : { kind: "pose", pose: view.camera.pose, fit: [] },
                })
              }
            >
              Fit
            </TooltipTrigger>
            <TooltipPopup>Fit the whole model in view</TooltipPopup>
          </Tooltip>
          <ToolbarDivider />
          <Tooltip>
            <TooltipTrigger
              aria-expanded={sectionOpen}
              data-active={sectionApplied || undefined}
              disabled={disabled}
              className={toolbarControl}
              onClick={() => setSectionOpen(!sectionOpen)}
            >
              <ScanIcon aria-hidden="true" />
              Section
            </TooltipTrigger>
            <TooltipPopup>
              {sectionApplied
                ? "Section applied: edit the cut plane"
                : "Cut the model with a plane"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              aria-label="Exploded view"
              aria-pressed={view.explosion > 0}
              disabled={disabled}
              className={toolbarControl}
              onClick={() => onChange({ ...view, explosion: view.explosion > 0 ? 0 : 1 })}
            >
              <StackIcon aria-hidden="true" />
              Explode
            </TooltipTrigger>
            <TooltipPopup>
              {view.explosion > 0 ? "Put the parts back together" : "Spread the parts apart"}
            </TooltipPopup>
          </Tooltip>
          {inspecting && (
            <>
              <ToolbarDivider />
              <Tooltip>
                <TooltipTrigger
                  aria-label="Reset inspection"
                  disabled={disabled}
                  className={toolbarControl}
                  onClick={() =>
                    onChange({
                      ...view,
                      highlightedOccurrenceIds: [],
                      ghost: null,
                      sectionPlanes: [],
                    })
                  }
                >
                  <ArrowUUpLeftIcon aria-hidden="true" />
                  Reset
                </TooltipTrigger>
                <TooltipPopup>Clear highlights, ghosting, and section planes</TooltipPopup>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </>
  );
}
