import type { CadViewState } from "@cadsense/contracts";
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
  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-3 flex justify-center">
      <div
        role="toolbar"
        aria-label="CAD camera views"
        className="pointer-events-auto flex max-w-full flex-wrap justify-center gap-0.5 rounded-md border border-border/70 bg-background/90 p-1 shadow-lg"
      >
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
