import { Bot, Box, Files, Globe2, type LucideIcon, X } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { type RightPanelSection, RIGHT_PANEL_SECTIONS } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";

interface RightPanelProps {
  mode: PreviewPanelMode;
  open?: boolean;
  onExited?: () => void;
  maximized?: boolean;
  layoutControls?: ReactNode;
  /** Section on screen, or null when the thread has nothing to show. */
  section: RightPanelSection | null;
  /** Sections the switcher offers. Agents and Browser are only offered while they have content. */
  available: Readonly<Record<RightPanelSection, boolean>>;
  onSelect: (section: RightPanelSection) => void;
  /** Running and waiting subagents. Badges Agents while another section is on screen. */
  liveAgentCount: number;
  /** A file edit is still saving. Marks Files. */
  filesPending: boolean;
  /** Closes the browser page on screen. Offered while Browser is the section on screen. */
  onCloseBrowser: () => void;
  children: ReactNode;
}

const SECTION_META = {
  cad: { label: "CAD", icon: Box },
  files: { label: "Files", icon: Files },
  agents: { label: "Agents", icon: Bot },
  browser: { label: "Browser", icon: Globe2 },
} as const satisfies Record<RightPanelSection, { label: string; icon: LucideIcon }>;

const isRightPanelSection = (value: unknown): value is RightPanelSection =>
  RIGHT_PANEL_SECTIONS.some((section) => section === value);

/**
 * The right panel: a fixed switcher between the thread's sections above the
 * section's content. Every section is single-instance, so there are no tabs
 * to open or close.
 */
export function RightPanel(props: RightPanelProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const sections = RIGHT_PANEL_SECTIONS.filter((section) => props.available[section]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.onExited !== undefined ? { onExited: props.onExited } : {})}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          // The sheet overlays from the viewport top, so its switcher row keeps
          // the titlebar's height: a compact row re-centers the layout
          // controls a few pixels higher and the cluster jumps on open.
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-switcher
      >
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1",
            ownsDesktopTitleBar && "drag-region",
          )}
        >
          {sections.length > 0 ? (
            <ToggleGroup
              variant="segmented"
              aria-label="Right panel section"
              value={props.section ? [props.section] : []}
              onValueChange={(value) => {
                // Pressing the section on screen would clear the group; ignore it.
                const next = value[0];
                if (isRightPanelSection(next)) props.onSelect(next);
              }}
            >
              {sections.map((section) => {
                const { label, icon: Icon } = SECTION_META[section];
                const showAgentBadge =
                  section === "agents" && props.section !== "agents" && props.liveAgentCount > 0;
                return (
                  <ToggleGroupItem key={section} value={section} aria-label={label}>
                    <Icon className="size-3.5" />
                    {label}
                    {showAgentBadge ? (
                      <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white">
                        {props.liveAgentCount}
                      </span>
                    ) : null}
                    {section === "files" && props.filesPending ? (
                      <span className="size-1.5 rounded-full bg-current" aria-hidden />
                    ) : null}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          ) : null}
          {props.section === "browser" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Close browser page"
                    className="text-muted-foreground hover:text-foreground"
                    size="icon-xs"
                    variant="ghost"
                    onClick={props.onCloseBrowser}
                  />
                }
              >
                <X className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Close browser page</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-section-content>
        {props.section === null ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-xs">
            Nothing to show for this thread yet.
          </div>
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
