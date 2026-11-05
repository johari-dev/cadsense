import { ArrowLeftIcon, XIcon as X } from "~/lib/icons";
import { useEffect, useLayoutEffect, type ReactNode } from "react";

import { isElectron } from "~/env";
import type { RightPanelSection } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { holdInspection } from "./sidebarInspection";
import { THREAD_SIDEBAR_DEFAULT_WIDTH } from "./threadSidebarWidth";

/** Chat column width the CAD panel's default leaves beside the default sidebar. */
const CAD_PANEL_DEFAULT_CHAT_WIDTH = 520;

/**
 * Initial CAD panel width before the user resizes it, for `defaultWidth`. It leaves a
 * readable chat column (520px beside the default sidebar, so 656px of CAD at 1440 wide,
 * enough for review answers) and never takes less than 45% of the window, so the model stays
 * the widest column.
 */
export function resolveDefaultCadPanelWidth(viewportWidth: number): number {
  return Math.round(
    Math.max(
      viewportWidth * 0.45,
      viewportWidth - THREAD_SIDEBAR_DEFAULT_WIDTH - CAD_PANEL_DEFAULT_CHAT_WIDTH,
    ),
  );
}

interface RightPanelProps {
  mode: PreviewPanelMode;
  /**
   * Where the inline panel sits. "left" is the CAD-first layout (ChatView decides it): the
   * panel leads the row, the chat sits to its right and owns the title bar's right end, and the
   * app sidebar folds to its rail. Defaults to "right".
   */
  side?: "left" | "right";
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
  /**
   * The project name, shown as the title while CAD is home and on screen. The CAD panel's
   * scene picker follows it in the title slot as the document's secondary label.
   */
  projectTitle?: string | undefined;
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
  drawing: "Part drawing",
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
  const leftSide = props.mode === "inline" && props.side === "left";
  // The title bar's right end (layout controls, native window controls) sits over this panel's
  // title row unless the panel is on the left with the chat beside it.
  const ownsDesktopTitleBar =
    isElectron && props.mode === "inline" && (!leftSide || props.maximized === true);
  const atHome = props.section !== null && props.section === props.home;
  // A maximized inline panel is an inspection: the app sidebar folds to its icon rail.
  const holdsInspection = props.mode === "inline" && props.maximized === true;
  useEffect(
    () => (holdsInspection ? holdInspection("panel-maximized") : undefined),
    [holdsInspection],
  );
  // So is the CAD-first layout while the panel is open. The width the rail frees goes to the
  // model (PreviewPanelShell), not the chat. `open` goes false as the close animation starts,
  // so the sidebar expands while the panel slides out. A layout effect, so the fold starts in
  // the same frame the panel opens.
  const holdsCadInspection = leftSide && props.open !== false;
  useLayoutEffect(
    () => (holdsCadInspection ? holdInspection("cad-panel-open") : undefined),
    [holdsCadInspection],
  );

  return (
    <PreviewPanelShell
      mode={props.mode}
      side={leftSide ? "left" : "right"}
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
          props.mode === "inline" && !props.layoutControls && (!leftSide || props.maximized)
            ? "pr-28"
            : "pr-3",
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
            <>
              {props.projectTitle ? (
                <h2 className="max-w-[50%] shrink-0 truncate pl-2 text-sm font-medium">
                  {props.projectTitle}
                </h2>
              ) : null}
              <div
                ref={props.titleSlotRef}
                className={cn(
                  "flex min-w-0 flex-1 items-center",
                  props.projectTitle ? "pl-1.5" : "pl-1",
                )}
              />
            </>
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
