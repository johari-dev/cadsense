import { useEffect, useRef, useState } from "react";

import { useModelThumbnail } from "~/cad/modelThumbnails";
import { useLingeringPresence } from "~/hooks/useLingeringPresence";
import { CubeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { Project } from "~/types";
import { DRAFT_HERO_TRANSITION_DURATION_MS } from "./draftHeroTransition";

/** Reach of the pointer light past the pane's edges, in pixels: the radius in `draft-hero-dots-light`. */
const POINTER_LIGHT_RADIUS = 180;

interface DraftHeroBackdropProps {
  /** The draft's project, or null while none is chosen. */
  readonly project: Project | null;
  /** Whether the draft hero is on screen. The backdrop fades out once when it leaves. */
  readonly shown: boolean;
  /** Whether the live model is on screen beside the chat, where a second, dim copy adds nothing. */
  readonly modelOnScreen: boolean;
}

/** What one layer of the backdrop draws: a CAD project's model, or the dot grid when null. */
interface BackdropArt {
  readonly key: string;
  readonly project: Project | null;
}

/**
 * The art behind the new thread view. It fills the chat column under the hero and never takes
 * pointer input. A CAD project shows its model, large and quiet, fading out where the headline
 * starts. Any other view shows a faint dot grid. Switching project cross-fades from one to the
 * other. Styles are the `draft-hero-*` utilities in index.css.
 */
export function DraftHeroBackdrop({ project, shown, modelOnScreen }: DraftHeroBackdropProps) {
  // Stay mounted through the fade-out, then drop the image and its URL query.
  const present = useLingeringPresence(shown, DRAFT_HERO_TRANSITION_DURATION_MS);
  // Every view with no model shares the one dot grid, so moving between them changes nothing.
  const art: BackdropArt = project?.cad?.enabled
    ? { key: `${project.environmentId}:${project.id}`, project }
    : { key: "dots", project: null };
  // The art before a switch stays for the cross-fade, then goes.
  const [current, setCurrent] = useState(art);
  const [leaving, setLeaving] = useState<BackdropArt | null>(null);
  if (current.key !== art.key) {
    setLeaving(current);
    setCurrent(art);
  }
  useEffect(() => {
    if (!leaving) return;
    const timeout = setTimeout(() => setLeaving(null), DRAFT_HERO_TRANSITION_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [leaving]);
  // True for the one render in which the live model leaves the screen. The pane the art is
  // centered in is still widening then, so art that appears in that render waits for it.
  const [wasOnScreen, setWasOnScreen] = useState(modelOnScreen);
  useEffect(() => setWasOnScreen(modelOnScreen), [modelOnScreen]);
  const paneWidening = wasOnScreen && !modelOnScreen;
  if (!present) return null;

  return (
    <div
      aria-hidden
      data-draft-hero-backdrop
      className={cn(
        "pointer-events-none absolute inset-0 z-10 overflow-hidden transition-opacity duration-300 ease-[cubic-bezier(0.2,0,0,1)] [container-type:size] motion-reduce:transition-none",
        shown ? "opacity-100" : "opacity-0",
      )}
    >
      {/* One soft light, so a dark model still separates from the canvas. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_58%_52%_at_50%_34%,--theme(--color-white/7%),transparent_72%)]" />
      {(leaving ? [leaving, art] : [art]).map((layer) => (
        <div
          key={layer.key}
          data-draft-hero-layer={layer === leaving ? "leaving" : "current"}
          className={cn(
            "absolute inset-0 transition-opacity ease-out motion-reduce:transition-none",
            layer === leaving
              ? // With the live model arriving, the pane narrows at once, so the old art goes at once.
                cn("opacity-0", modelOnScreen ? "duration-75" : "duration-300")
              : cn("opacity-100 duration-300 starting:opacity-0", paneWidening && "delay-150"),
          )}
        >
          {layer.project ? (
            <ModelArt project={layer.project} hidden={modelOnScreen} delayed={paneWidening} />
          ) : (
            <SheetDots />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The project's model from the backdrop the CAD panel saved for its current snapshot, or an
 * outline holding its place until one is saved. `hidden` takes it off screen at once. `delayed`
 * holds its return for a moment. Never loads CAD just to draw it.
 */
function ModelArt({
  project,
  hidden,
  delayed,
}: {
  readonly project: Project;
  readonly hidden: boolean;
  readonly delayed: boolean;
}) {
  const snapshotId = project.cad?.roots.find((root) => root.current)?.current?.snapshotId;
  const backdrop = useModelThumbnail(project.environmentId, snapshotId, "backdrop");
  // The snapshot whose image has loaded, so the model fades in once and not on every URL refresh.
  const [loadedSnapshotId, setLoadedSnapshotId] = useState<string | null>(null);

  if (!backdrop.url) {
    // While the server has not answered, draw nothing: a saved backdrop must not flash the
    // outline first.
    return snapshotId === undefined || backdrop.missing ? (
      <CubeIcon
        weight="thin"
        className="draft-hero-art absolute top-[34%] left-1/2 size-58 -translate-1/2 text-foreground/7"
      />
    ) : null;
  }
  return (
    <div
      className={cn(
        "draft-hero-art draft-hero-fade absolute inset-0 transition-opacity motion-reduce:transition-none",
        // The model leaves at once, before the pane it is centered in has narrowed much, and
        // comes back after the pane has widened again. Either way it never slides while visible.
        hidden || loadedSnapshotId !== snapshotId
          ? "opacity-0 duration-75 ease-out"
          : cn("opacity-100 duration-200", delayed && "delay-150"),
      )}
    >
      {/* The model fits a box 70% of the pane wide, or the whole pane up to 520px when that is
          wider, and 90% tall up to 860px, starting 1.5rem below the pane's top. It sits at half
          strength with most color removed. */}
      <img
        src={backdrop.url}
        alt=""
        decoding="async"
        onLoad={() => setLoadedSnapshotId(snapshotId ?? null)}
        className="absolute top-6 left-1/2 h-[min(90%,860px)] w-[max(70%,min(100%,520px))] -translate-x-1/2 object-contain object-[center_35%] opacity-50 saturate-[0.4]"
      />
    </div>
  );
}

/**
 * The dot grid for views with no model. A ripple reveals it once, then dots near the pointer
 * brighten. The light moves only on pointer events, so an idle view repaints nothing.
 */
function SheetDots() {
  const light = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = light.current;
    if (!element) return;
    let lit = false;
    // The backdrop takes no pointer input itself, so follow the pointer from the window.
    const follow = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const box = element.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      const near =
        x > -POINTER_LIGHT_RADIUS &&
        y > -POINTER_LIGHT_RADIUS &&
        x < box.width + POINTER_LIGHT_RADIUS &&
        y < box.height + POINTER_LIGHT_RADIUS;
      // Once the light has left the pane, further moves outside it change nothing.
      if (!near && !lit) return;
      lit = near;
      element.style.setProperty("--draft-hero-pointer-x", `${x}px`);
      element.style.setProperty("--draft-hero-pointer-y", `${y}px`);
    };
    window.addEventListener("pointermove", follow, { passive: true });
    return () => window.removeEventListener("pointermove", follow);
  }, []);

  return (
    <div className="draft-hero-art draft-hero-dots-fade absolute inset-0">
      <div className="draft-hero-dots absolute inset-0" />
      <div className="draft-hero-dots-bright draft-hero-dots-ripple absolute inset-0" />
      <div ref={light} className="draft-hero-dots-bright draft-hero-dots-light absolute inset-0" />
    </div>
  );
}
