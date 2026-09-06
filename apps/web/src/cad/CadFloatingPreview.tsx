import { type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { PanelRightIcon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
} from "../components/preview/previewMiniPlayerLayout";

/** Uses the browser mini-player's placement constraints without allocating another browser or GPU. */
export function CadFloatingPreview({
  children,
  bottomInset,
  onDock,
  onClose,
}: {
  children: ReactNode;
  bottomInset: number;
  onDock: () => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<{ x: number; y: number; width: number; height: number }>({
    x: 12,
    y: 12,
    ...PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  });
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    layout: typeof layout;
    resize: boolean;
  } | null>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const parent = root.current?.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    const clamp = () =>
      setLayout((current) => {
        const container = { width: parent.clientWidth, height: parent.clientHeight };
        const size = clampPreviewMiniPlayerSize(current, container, bottomInset);
        const position = clampPreviewMiniPlayerPosition(
          placed.current ? current : { x: container.width - size.width - 12, y: 12 },
          container,
          size,
          bottomInset,
        );
        placed.current = true;
        const next = { ...position, ...size };
        return Object.keys(next).every(
          (key) => Reflect.get(next, key) === Reflect.get(current, key),
        )
          ? current
          : next;
      });
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [bottomInset]);
  const start = (event: PointerEvent<HTMLElement>, resize: boolean) => {
    if (event.button !== 0) return;
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      layout,
      resize,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    const parent = root.current?.offsetParent;
    if (!current || current.pointerId !== event.pointerId || !(parent instanceof HTMLElement))
      return;
    const container = { width: parent.clientWidth, height: parent.clientHeight };
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    const size = clampPreviewMiniPlayerSize(
      current.resize
        ? { width: current.layout.width + dx, height: current.layout.height + dy }
        : current.layout,
      container,
      bottomInset,
    );
    const position = clampPreviewMiniPlayerPosition(
      current.resize ? current.layout : { x: current.layout.x + dx, y: current.layout.y + dy },
      container,
      size,
      bottomInset,
    );
    setLayout({ ...position, ...size });
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <section
      ref={root}
      aria-label="Floating CAD preview"
      className="cad-floating-preview absolute z-30 flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background shadow-2xl/35"
      style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height }}
    >
      <div
        className="flex h-8 shrink-0 cursor-grab touch-none items-center gap-1 border-b px-2 active:cursor-grabbing"
        onPointerDown={(event) => start(event, false)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span className="flex-1 select-none text-xs text-muted-foreground">CAD</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open CAD in right panel"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onDock}
              />
            }
          >
            <PanelRightIcon />
          </TooltipTrigger>
          <TooltipPopup>Open in right panel</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close floating CAD preview"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onClose}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Close floating preview</TooltipPopup>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
      <button
        type="button"
        aria-label="Resize floating CAD preview"
        className="absolute bottom-0 right-0 size-5 cursor-nwse-resize touch-none rounded-br-xl after:absolute after:bottom-1 after:right-1 after:size-2 after:border-b after:border-r after:border-foreground/45"
        onPointerDown={(event) => start(event, true)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </section>
  );
}
