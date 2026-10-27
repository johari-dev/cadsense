import { ArrowLeftIcon, XIcon as X } from "~/lib/icons";
import type { ReactNode } from "react";

import { isElectron } from "~/env";
import type { RightPanelSection } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { THREAD_SIDEBAR_DEFAULT_WIDTH } from "./threadSidebarWidth";

/** Chat column width the CAD panel's default leaves beside the default sidebar. */
const CAD_PANEL_DEFAULT_CHAT_WIDTH = 440;

/**
 * Initial CAD panel width before the user resizes it, for `defaultWidth`. It leaves a
 * readable chat column (440px beside the default sidebar, so 768px of CAD at 1440 wide)
 * and never takes less than half the window, so the model stays the dominant column.
 */
export function resolveDefaultCadPanelWidth(viewportWidth: number): number {
  return Math.round(
    Math.max(
      viewportWidth * 0.5,
      viewportWidth - THREAD_SIDEBAR_DEFAULT_WIDTH - CAD_PANEL_DEFAULT_CHAT_WIDTH,
    ),
  );
}

interface RightPanelProps {
  mode: PreviewPanelMode;
  open?: boolean;
  onExited?: () => void;
  maximized?: boolean;
  layoutControls?: ReactNode;
  /** Forwarded to PreviewPanelShell so this panel persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  /** Section on screen, or null when the thread has nothing to show. */
  section: RightPanelSection | null;
  /** Section Back returns to: CAD on CAD projects, otherwise Files. Null when there is neither. */
  home: RightPanelSection | null;
  /** Names `home` on the Back button, such as the synced model's name. */
  homeLabel: string;
  onBack: () => void;
  /**
   * Receives the title row's slot while CAD is home and on screen, so the CAD panel can
   * render its scene picker there instead of in a row of its own.
   */
  titleSlotRef?: (node: HTMLElement | null) => void;
  /** Closes the browser page on screen. Offered while Browser is the section on screen. */
  onCloseBrowser: () => void;
  children: ReactNode;
}

const SECTION_LABEL = {
  cad: "CAD",
  files: "Files",
  agents: "Agents",
  browser: "Browser",
} as const satisfies Record<RightPanelSection, string>;

/**
 * The right panel: one section at a time under a title row. The panel's home section
 * (CAD, or Files on projects without CAD) shows its own title there; CAD renders its scene
 * picker into the row through `titleSlotRef`. Any other section takes over the
 * panel when something opens it (a file link, the agents row, a browser page) and the
 * row offers a way back home.
 */
export function RightPanel(props: RightPanelProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const atHome = props.section !== null && props.section === props.home;

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.onExited !== undefined ? { onExited: props.onExited } : {})}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          // The sheet overlays from the viewport top, so its title row keeps
          // the titlebar's height: a compact row re-centers the layout
          // controls a few pixels higher and the cluster jumps on open.
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-header
      >
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1",
            ownsDesktopTitleBar && "drag-region",
          )}
        >
          {props.section === "cad" && atHome ? (
            <div ref={props.titleSlotRef} className="flex min-w-0 flex-1 items-center pl-1" />
          ) : props.section !== null ? (
            <>
              {props.home !== null && !atHome ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Back to ${props.homeLabel}`}
                    onClick={props.onBack}
                  >
                    <ArrowLeftIcon className="size-3.5" />
                    <span className="truncate">{props.homeLabel}</span>
                  </Button>
                  <span aria-hidden className="text-muted-foreground/60 text-sm">
                    /
                  </span>
                </>
              ) : null}
              <h2 className={cn("shrink-0 px-1 text-sm font-medium", atHome && "pl-2")}>
                {SECTION_LABEL[props.section]}
              </h2>
            </>
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
