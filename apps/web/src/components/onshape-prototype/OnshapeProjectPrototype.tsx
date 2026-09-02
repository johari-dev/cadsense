// PROTOTYPE: three Onshape project UX variants on the existing `/` route,
// switchable with `?prototype=onshape&variant=`, and never rendered in production.
import {
  AlertTriangle,
  Box,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Eye,
  EyeOff,
  Folder,
  Layers3,
  Lock,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SidebarInset } from "../ui/sidebar";

const VARIANTS = [
  { key: "A", name: "Docked tool" },
  { key: "B", name: "CAD workspace" },
  { key: "C", name: "Capture-led thread" },
] as const;

const SCENARIOS = [
  { key: "setup", label: "Add project" },
  { key: "downloading", label: "Downloading" },
  { key: "ready", label: "Ready" },
  { key: "running", label: "Agent running" },
  { key: "older", label: "Older download" },
  { key: "offline", label: "Offline" },
  { key: "error", label: "Download failed" },
] as const;

type VariantKey = (typeof VARIANTS)[number]["key"];
type ScenarioKey = (typeof SCENARIOS)[number]["key"];

const ROOTS = ["Main assembly", "Housing assembly", "Mounting plate"] as const;

function readVariant(): VariantKey {
  const value = new URLSearchParams(window.location.search).get("variant");
  return VARIANTS.some((variant) => variant.key === value) ? (value as VariantKey) : "A";
}

function readScenario(): ScenarioKey {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return SCENARIOS.some((scenario) => scenario.key === value) ? (value as ScenarioKey) : "ready";
}

function replacePrototypeSearch(key: "variant" | "scenario", value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("prototype", "onshape");
  url.searchParams.set(key, value);
  window.history.replaceState(window.history.state, "", url);
}

export function OnshapeProjectPrototype() {
  const [variant, setVariantState] = useState<VariantKey>(readVariant);
  const [scenario, setScenarioState] = useState<ScenarioKey>(readScenario);
  const [sceneRoot, setSceneRoot] = useState<(typeof ROOTS)[number]>(ROOTS[0]);
  const [hiddenOccurrences, setHiddenOccurrences] = useState(0);
  const [explosion, setExplosion] = useState(0);

  const setVariant = useCallback((next: VariantKey) => {
    replacePrototypeSearch("variant", next);
    setVariantState(next);
  }, []);
  const setScenario = useCallback((next: ScenarioKey) => {
    replacePrototypeSearch("scenario", next);
    setScenarioState(next);
  }, []);

  const cycleVariant = useCallback(
    (direction: -1 | 1) => {
      const index = VARIANTS.findIndex((entry) => entry.key === variant);
      const next = VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length];
      if (next) setVariant(next.key);
    },
    [setVariant, variant],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      event.preventDefault();
      cycleVariant(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleVariant]);

  const shared = {
    scenario,
    setScenario,
    sceneRoot,
    setSceneRoot,
    hiddenOccurrences,
    setHiddenOccurrences,
    explosion,
    setExplosion,
  } as const;

  return (
    <SidebarInset className="relative h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-9">
        <ScenarioBar scenario={scenario} setScenario={setScenario} />
        {variant === "A" ? <VariantA {...shared} /> : null}
        {variant === "B" ? <VariantB {...shared} /> : null}
        {variant === "C" ? <VariantC {...shared} /> : null}
      </div>
      <PrototypeState
        variant={variant}
        scenario={scenario}
        sceneRoot={sceneRoot}
        hiddenOccurrences={hiddenOccurrences}
        explosion={explosion}
      />
      <PrototypeSwitcher variant={variant} cycle={cycleVariant} />
    </SidebarInset>
  );
}

interface VariantProps {
  readonly scenario: ScenarioKey;
  readonly setScenario: (scenario: ScenarioKey) => void;
  readonly sceneRoot: (typeof ROOTS)[number];
  readonly setSceneRoot: (root: (typeof ROOTS)[number]) => void;
  readonly hiddenOccurrences: number;
  readonly setHiddenOccurrences: (count: number) => void;
  readonly explosion: number;
  readonly setExplosion: (amount: number) => void;
}

function ScenarioBar(props: {
  scenario: ScenarioKey;
  setScenario: (scenario: ScenarioKey) => void;
}) {
  return (
    <div className="absolute inset-x-0 top-0 z-40 flex h-9 items-center gap-1 overflow-x-auto border-b border-border bg-zinc-950 px-3 text-zinc-100 shadow-sm">
      <span className="mr-2 shrink-0 text-[10px] font-semibold tracking-[0.16em] text-zinc-400 uppercase">
        Prototype scenario
      </span>
      {SCENARIOS.map((scenario) => (
        <button
          key={scenario.key}
          type="button"
          onClick={() => props.setScenario(scenario.key)}
          className={`shrink-0 rounded-md px-2 py-1 text-[11px] transition-colors ${
            scenario.key === props.scenario
              ? "bg-white text-zinc-950"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          }`}
        >
          {scenario.label}
        </button>
      ))}
    </div>
  );
}

function PrototypeSwitcher(props: { variant: VariantKey; cycle: (direction: -1 | 1) => void }) {
  const current = VARIANTS.find((variant) => variant.key === props.variant) ?? VARIANTS[0];
  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-zinc-950 p-1 text-white shadow-2xl shadow-black/40">
      <button
        type="button"
        aria-label="Previous prototype variant"
        onClick={() => props.cycle(-1)}
        className="grid size-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-36 px-3 text-center text-xs font-medium">
        {current.key} <span className="text-zinc-400">({current.name})</span>
      </span>
      <button
        type="button"
        aria-label="Next prototype variant"
        onClick={() => props.cycle(1)}
        className="grid size-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-white"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function PrototypeState(props: {
  variant: VariantKey;
  scenario: ScenarioKey;
  sceneRoot: string;
  hiddenOccurrences: number;
  explosion: number;
}) {
  return (
    <div className="pointer-events-none fixed bottom-4 left-[calc(var(--sidebar-width)+1rem)] z-40 hidden rounded-lg border border-border/80 bg-background/92 px-3 py-2 text-[10px] text-muted-foreground shadow-lg backdrop-blur-md xl:block">
      <span className="font-semibold text-foreground">Visible state</span>
      <span className="ml-2">variant {props.variant}</span>
      <span className="ml-2">scenario {props.scenario}</span>
      <span className="ml-2">root {props.sceneRoot}</span>
      <span className="ml-2">hidden {props.hiddenOccurrences}</span>
      <span className="ml-2">explode {props.explosion.toFixed(1)}</span>
    </div>
  );
}

function VariantA(props: VariantProps) {
  const locked = props.scenario === "running" || props.scenario === "downloading";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <ThreadHeader scenario={props.scenario} onSync={() => props.setScenario("downloading")} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,1fr)_minmax(380px,46%)]">
        <ChatColumn scenario={props.scenario} />
        <section className="flex min-h-0 flex-col border-l border-border bg-card/20">
          <div className="flex h-10 shrink-0 items-center border-b border-border px-2">
            <div className="flex h-full items-center gap-1 border-b-2 border-foreground px-2 text-xs font-medium">
              <Box className="size-3.5 text-[#00a8a0]" /> CAD
            </div>
            <div className="ml-1 flex h-full items-center px-2 text-xs text-muted-foreground">
              Agents
            </div>
            <button
              type="button"
              className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <CadPanelHeader
            scenario={props.scenario}
            sceneRoot={props.sceneRoot}
            setSceneRoot={props.setSceneRoot}
          />
          <CadCanvas
            scenario={props.scenario}
            sceneRoot={props.sceneRoot}
            locked={locked}
            hiddenOccurrences={props.hiddenOccurrences}
            explosion={props.explosion}
            onNoticeAction={() =>
              props.setScenario(props.scenario === "error" ? "downloading" : "ready")
            }
          />
          <CadToolbar
            locked={locked}
            hiddenOccurrences={props.hiddenOccurrences}
            setHiddenOccurrences={props.setHiddenOccurrences}
            explosion={props.explosion}
            setExplosion={props.setExplosion}
          />
        </section>
      </div>
      {props.scenario === "setup" ? (
        <SetupDialog onContinue={() => props.setScenario("downloading")} />
      ) : null}
    </div>
  );
}

function VariantB(props: VariantProps) {
  if (props.scenario === "setup") {
    return <SetupWorkspace onContinue={() => props.setScenario("downloading")} />;
  }
  const locked = props.scenario === "running" || props.scenario === "downloading";
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <OnshapeMark className="size-5" />
        <div className="ml-2 min-w-0">
          <div className="truncate text-sm font-medium">Assembly review</div>
          <DownloadStatus scenario={props.scenario} />
        </div>
        <div className="mx-auto flex items-center rounded-lg bg-muted/70 p-0.5">
          {ROOTS.map((root) => (
            <button
              key={root}
              type="button"
              disabled={locked}
              onClick={() => props.setSceneRoot(root)}
              className={`rounded-md px-3 py-1.5 text-xs ${
                root === props.sceneRoot
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              } disabled:opacity-50`}
            >
              {root}
            </button>
          ))}
        </div>
        <SyncButton scenario={props.scenario} onSync={() => props.setScenario("downloading")} />
        <button
          type="button"
          className="ml-1 grid size-8 place-items-center rounded-md hover:bg-muted"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[210px_minmax(420px,1fr)_minmax(300px,34%)]">
        <SceneTree
          locked={locked}
          sceneRoot={props.sceneRoot}
          hiddenOccurrences={props.hiddenOccurrences}
          setHiddenOccurrences={props.setHiddenOccurrences}
        />
        <section className="relative flex min-h-0 flex-col border-x border-border bg-card/20">
          <CadCanvas
            scenario={props.scenario}
            sceneRoot={props.sceneRoot}
            locked={locked}
            hiddenOccurrences={props.hiddenOccurrences}
            explosion={props.explosion}
            onNoticeAction={() =>
              props.setScenario(props.scenario === "error" ? "downloading" : "ready")
            }
          />
          <CadToolbar
            locked={locked}
            hiddenOccurrences={props.hiddenOccurrences}
            setHiddenOccurrences={props.setHiddenOccurrences}
            explosion={props.explosion}
            setExplosion={props.setExplosion}
          />
        </section>
        <ChatColumn scenario={props.scenario} compact />
      </div>
    </div>
  );
}

function VariantC(props: VariantProps) {
  const locked = props.scenario === "running" || props.scenario === "downloading";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <ThreadHeader scenario={props.scenario} onSync={() => props.setScenario("downloading")} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(460px,1fr)_260px]">
        <main className="min-h-0 overflow-y-auto px-6 pb-32 pt-7">
          <div className="mx-auto max-w-3xl space-y-5">
            {props.scenario === "setup" ? (
              <InlineSetup onContinue={() => props.setScenario("downloading")} />
            ) : (
              <>
                <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md bg-message px-4 py-3 text-sm text-message-foreground">
                  Check the selected assembly for interference and show me what you find.
                </div>
                <div className="max-w-[82%] text-sm leading-relaxed text-foreground/90">
                  I’m inspecting the downloaded CAD now. I’ll keep the useful captured view here.
                </div>
                <article className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                  <div className="flex h-11 items-center gap-2 border-b border-border px-3">
                    <OnshapeMark className="size-4" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{props.sceneRoot}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {props.scenario === "running"
                          ? "Agent capture updating"
                          : "Latest CAD capture"}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                    >
                      <Maximize2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="h-[min(46vh,410px)]">
                    <CadCanvas
                      scenario={props.scenario}
                      sceneRoot={props.sceneRoot}
                      locked={locked}
                      hiddenOccurrences={props.hiddenOccurrences}
                      explosion={props.explosion}
                      captureCard
                      onNoticeAction={() =>
                        props.setScenario(props.scenario === "error" ? "downloading" : "ready")
                      }
                    />
                  </div>
                </article>
                <div className="max-w-[82%] text-sm leading-relaxed text-foreground/90">
                  The highlighted bracket is the closest point. The current spacing appears
                  consistent, but I would verify the fastener head clearance before fabrication.
                </div>
              </>
            )}
          </div>
        </main>
        <aside className="flex min-h-0 flex-col border-l border-border bg-card/25">
          <div className="border-b border-border p-4">
            <div className="flex items-center gap-2">
              <OnshapeMark className="size-5" />
              <div>
                <div className="text-sm font-medium">Assembly review</div>
                <DownloadStatus scenario={props.scenario} />
              </div>
            </div>
            <SyncButton
              scenario={props.scenario}
              onSync={() => props.setScenario("downloading")}
              className="mt-3 w-full justify-center"
            />
          </div>
          <div className="p-3">
            <div className="mb-2 px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              CAD
            </div>
            {ROOTS.map((root) => (
              <button
                key={root}
                type="button"
                disabled={locked}
                onClick={() => props.setSceneRoot(root)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
                  root === props.sceneRoot
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:bg-muted/60"
                } disabled:opacity-50`}
              >
                <Box className="size-3.5" />
                <span className="truncate">{root}</span>
              </button>
            ))}
          </div>
          <div className="mt-auto border-t border-border p-3 text-xs text-muted-foreground">
            Captures appear in this thread automatically. Viewer controls remain private until
            capture.
          </div>
        </aside>
      </div>
      <ComposerMock />
    </div>
  );
}

function ThreadHeader(props: { scenario: ScenarioKey; onSync: () => void }) {
  return (
    <header className="flex h-13 shrink-0 items-center border-b border-border px-4">
      <div className="min-w-0 flex-1 pl-9">
        <div className="truncate text-sm font-medium">Review assembly clearances</div>
        <div className="truncate text-[11px] text-muted-foreground">Assembly review</div>
      </div>
      <DownloadStatus scenario={props.scenario} />
      <SyncButton scenario={props.scenario} onSync={props.onSync} className="ml-3" />
      <button
        type="button"
        className="ml-1 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted"
      >
        <PanelRight className="size-4" />
      </button>
    </header>
  );
}

function ChatColumn(props: { scenario: ScenarioKey; compact?: boolean }) {
  return (
    <section className="relative flex min-h-0 flex-col bg-background">
      <div
        className={`min-h-0 flex-1 overflow-y-auto ${props.compact ? "px-4 py-5" : "px-8 py-7"}`}
      >
        <div className="mx-auto max-w-2xl space-y-5">
          <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-message px-4 py-3 text-sm text-message-foreground">
            Check the selected assembly for interference and show me what you find.
          </div>
          <div className="max-w-[92%] text-sm leading-relaxed text-foreground/90">
            I’m reviewing the downloaded CAD. I’ll capture the useful angle once the surrounding
            parts are hidden.
          </div>
          {props.scenario === "running" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" /> Inspecting CAD
            </div>
          ) : null}
        </div>
      </div>
      <div className="p-4 pb-16">
        <div className="mx-auto max-w-2xl rounded-2xl border border-border bg-card px-3 py-3 text-sm text-muted-foreground shadow-sm">
          Ask a follow-up…
          <div className="mt-4 flex items-center justify-between">
            <Plus className="size-4" />
            <div className="flex items-center gap-2 text-xs">
              Codex <span className="rounded-md bg-foreground px-2 py-1 text-background">Send</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ComposerMock() {
  return (
    <div className="pointer-events-none absolute inset-x-6 bottom-12 z-10 mx-auto max-w-3xl rounded-2xl border border-border bg-background/92 p-3 text-sm text-muted-foreground shadow-xl backdrop-blur-md">
      Ask a follow-up…
      <div className="mt-3 flex justify-between text-xs">
        <Plus className="size-4" />
        <span>Codex</span>
      </div>
    </div>
  );
}

function DownloadStatus({ scenario }: { scenario: ScenarioKey }) {
  if (scenario === "offline") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <CloudOff className="size-3" /> Offline · downloaded CAD available
      </span>
    );
  }
  if (scenario === "downloading") {
    return <span className="text-[11px] text-muted-foreground">Downloading CAD · 62%</span>;
  }
  if (scenario === "error") {
    return <span className="text-[11px] text-error">Download failed · previous CAD available</span>;
  }
  if (scenario === "older") {
    return <span className="text-[11px] text-muted-foreground">Downloaded Aug 20</span>;
  }
  if (scenario === "setup") {
    return <span className="text-[11px] text-muted-foreground">Not connected</span>;
  }
  return <span className="text-[11px] text-muted-foreground">Downloaded just now</span>;
}

function SyncButton(props: { scenario: ScenarioKey; onSync: () => void; className?: string }) {
  const disabled =
    props.scenario === "running" ||
    props.scenario === "downloading" ||
    props.scenario === "offline" ||
    props.scenario === "setup";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={props.onSync}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 ${props.className ?? ""}`}
    >
      <RefreshCw className="size-3.5" />
      {props.scenario === "downloading" ? "Downloading" : "Sync CAD"}
    </button>
  );
}

function CadPanelHeader(props: {
  scenario: ScenarioKey;
  sceneRoot: (typeof ROOTS)[number];
  setSceneRoot: (root: (typeof ROOTS)[number]) => void;
}) {
  const locked = props.scenario === "running" || props.scenario === "downloading";
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      <button
        type="button"
        disabled={locked}
        onClick={() => {
          const current = ROOTS.indexOf(props.sceneRoot);
          props.setSceneRoot(ROOTS[(current + 1) % ROOTS.length] ?? ROOTS[0]);
        }}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        <span className="truncate">{props.sceneRoot}</span>
        <ChevronDown className="size-3.5" />
      </button>
      <span className="ml-auto">
        <DownloadStatus scenario={props.scenario} />
      </span>
      <button
        type="button"
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
      >
        <MoreHorizontal className="size-3.5" />
      </button>
    </div>
  );
}

function CadCanvas(props: {
  scenario: ScenarioKey;
  sceneRoot: string;
  locked: boolean;
  hiddenOccurrences: number;
  explosion: number;
  captureCard?: boolean;
  onNoticeAction?: () => void;
}) {
  const spread = props.explosion * 26;
  const muted = props.hiddenOccurrences > 0;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle_at_50%_38%,color-mix(in_srgb,var(--muted)_72%,transparent),var(--background)_72%)]">
      <svg
        viewBox="0 0 760 520"
        className="size-full"
        role="img"
        aria-label={`${props.sceneRoot} CAD preview`}
      >
        <defs>
          <linearGradient id="cad-metal" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#c6cbd2" />
            <stop offset="1" stopColor="#6f7884" />
          </linearGradient>
          <linearGradient id="cad-dark" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#586270" />
            <stop offset="1" stopColor="#262c34" />
          </linearGradient>
          <pattern id="cad-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <path
              d="M 28 0 L 0 0 0 28"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.08"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="760" height="520" fill="url(#cad-grid)" className="text-foreground" />
        <g transform="translate(380 270)">
          <ellipse cx="0" cy="164" rx="250" ry="30" fill="black" opacity="0.12" />
          <g transform={`translate(${-spread} ${spread * 0.25})`} opacity={muted ? 0.24 : 1}>
            <path
              d="M-250 40 L-72 -64 L126 44 L-52 148 Z"
              fill="url(#cad-dark)"
              stroke="#151a20"
              strokeWidth="3"
            />
            <path d="M-250 40 L-250 68 L-52 176 L-52 148 Z" fill="#20262d" />
            <path d="M-52 148 L126 44 L126 72 L-52 176 Z" fill="#343c46" />
            <circle cx="-184" cy="55" r="13" fill="#171c22" stroke="#8c96a2" strokeWidth="4" />
            <circle cx="45" cy="60" r="13" fill="#171c22" stroke="#8c96a2" strokeWidth="4" />
          </g>
          <g transform={`translate(${spread * 0.45} ${-spread})`}>
            <path
              d="M-105 -58 L-30 -102 L72 -48 L-2 -4 Z"
              fill="url(#cad-metal)"
              stroke="#59616b"
              strokeWidth="3"
            />
            <path
              d="M-105 -58 L-105 54 L-2 110 L-2 -4 Z"
              fill="#737d89"
              stroke="#505964"
              strokeWidth="3"
            />
            <path
              d="M-2 -4 L72 -48 L72 64 L-2 110 Z"
              fill="#9ca5ae"
              stroke="#59616b"
              strokeWidth="3"
            />
            <ellipse
              cx="-50"
              cy="-58"
              rx="27"
              ry="14"
              fill="#303741"
              stroke="#d1d5da"
              strokeWidth="5"
            />
          </g>
          <g transform={`translate(${95 + spread} ${-35 - spread * 0.4})`}>
            <path
              d="M-22 -90 L31 -60 L31 80 L-22 50 Z"
              fill="#00a8a0"
              stroke="#007b75"
              strokeWidth="3"
            />
            <path
              d="M31 -60 L57 -76 L57 64 L31 80 Z"
              fill="#007f79"
              stroke="#006762"
              strokeWidth="3"
            />
            <circle cx="4" cy="-45" r="10" fill="#162128" stroke="#9be1dd" strokeWidth="3" />
            <circle cx="4" cy="23" r="10" fill="#162128" stroke="#9be1dd" strokeWidth="3" />
          </g>
          <g transform={`translate(${-112 - spread * 0.5} ${-38 - spread * 0.6})`}>
            <rect
              x="-28"
              y="-62"
              width="56"
              height="126"
              rx="18"
              fill="#313944"
              stroke="#717c88"
              strokeWidth="4"
            />
            <ellipse cx="0" cy="-62" rx="28" ry="13" fill="#89939d" />
            <ellipse cx="0" cy="64" rx="28" ry="13" fill="#1e242b" />
          </g>
        </g>
      </svg>
      <div className="absolute left-3 top-3 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm">
        {props.sceneRoot}
      </div>
      {props.scenario === "offline" ? (
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-md bg-background/85 px-2 py-1 text-[10px] text-muted-foreground">
          <CloudOff className="size-3" /> Local CAD
        </div>
      ) : null}
      {props.scenario === "downloading" ? (
        <CanvasNotice
          icon={<RefreshCw className="size-4" />}
          title="Downloading CAD"
          description="The current download remains visible until the replacement is complete."
          action="Finish download"
          onAction={props.onNoticeAction}
        />
      ) : null}
      {props.scenario === "error" ? (
        <CanvasNotice
          icon={<AlertTriangle className="size-4 text-error" />}
          title="CAD download didn’t finish"
          description="The previous downloaded CAD is still available."
          action="Try again"
          onAction={props.onNoticeAction}
        />
      ) : null}
      {props.scenario === "running" ? (
        <div className="absolute inset-x-0 bottom-4 mx-auto flex w-max items-center gap-2 rounded-full border border-border bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur-md">
          <Lock className="size-3.5" /> Agent is inspecting CAD · controls locked
        </div>
      ) : null}
      {props.captureCard && props.scenario !== "running" ? (
        <div className="absolute bottom-3 right-3 rounded-md bg-zinc-950/80 px-2 py-1 text-[10px] text-white">
          Captured for this thread
        </div>
      ) : null}
    </div>
  );
}

function CanvasNotice(props: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;
  onAction: (() => void) | undefined;
}) {
  return (
    <div className="absolute left-1/2 top-1/2 w-72 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background/95 p-4 shadow-xl backdrop-blur-md">
      <div className="flex items-center gap-2 text-sm font-medium">
        {props.icon} {props.title}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{props.description}</p>
      <button
        type="button"
        onClick={props.onAction}
        className="mt-3 rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background"
      >
        {props.action}
      </button>
    </div>
  );
}

function CadToolbar(props: {
  locked: boolean;
  hiddenOccurrences: number;
  setHiddenOccurrences: (count: number) => void;
  explosion: number;
  setExplosion: (amount: number) => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-border px-2">
      <ToolButton label="Fit" disabled={props.locked} icon={<Maximize2 className="size-3.5" />} />
      <ToolButton label="View" disabled={props.locked} icon={<Camera className="size-3.5" />} />
      <ToolButton
        label={props.hiddenOccurrences > 0 ? "Show all" : "Hide part"}
        disabled={props.locked}
        icon={
          props.hiddenOccurrences > 0 ? (
            <Eye className="size-3.5" />
          ) : (
            <EyeOff className="size-3.5" />
          )
        }
        onClick={() => props.setHiddenOccurrences(props.hiddenOccurrences > 0 ? 0 : 4)}
      />
      <ToolButton
        label={props.explosion > 0 ? "Collapse" : "Explode"}
        disabled={props.locked}
        icon={<Layers3 className="size-3.5" />}
        onClick={() => props.setExplosion(props.explosion > 0 ? 0 : 0.65)}
      />
      <span className="ml-auto text-[10px] text-muted-foreground">
        {props.hiddenOccurrences} hidden · {Math.round(props.explosion * 100)}% exploded
      </span>
    </div>
  );
}

function ToolButton(props: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
    >
      {props.icon} {props.label}
    </button>
  );
}

function SceneTree(props: {
  locked: boolean;
  sceneRoot: string;
  hiddenOccurrences: number;
  setHiddenOccurrences: (count: number) => void;
}) {
  const nodes = [
    ["Housing", 1],
    ["Drive module", 1],
    ["Motor bracket", 2],
    ["Fastener set", 2],
    ["Mounting plate", 1],
  ] as const;
  return (
    <aside className="min-h-0 overflow-y-auto p-3">
      <div className="mb-2 flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground">
        <Search className="size-3.5" /> Search parts
      </div>
      <div className="mb-2 px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {props.sceneRoot}
      </div>
      {nodes.map(([label, depth], index) => {
        const hidden = props.hiddenOccurrences > 0 && index > 1;
        return (
          <button
            key={label}
            type="button"
            disabled={props.locked}
            onClick={() => props.setHiddenOccurrences(hidden ? 0 : index + 1)}
            className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-45"
            style={{ paddingLeft: `${depth * 10}px` }}
          >
            {depth === 1 ? <ChevronDown className="size-3" /> : <span className="w-3" />}
            <Box className="size-3.5" />
            <span className={`min-w-0 flex-1 truncate ${hidden ? "line-through opacity-55" : ""}`}>
              {label}
            </span>
            {hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          </button>
        );
      })}
    </aside>
  );
}

function SetupDialog({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-background/65 p-6 backdrop-blur-[2px]">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-popover p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Add project</h2>
          <X className="size-4 text-muted-foreground" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <ChoiceCard
            icon={<Folder className="size-5" />}
            title="Folder"
            description="Use a folder already on this machine."
          />
          <ChoiceCard
            icon={<OnshapeMark className="size-5" />}
            title="Onshape project"
            description="Use downloaded CAD and a managed workspace."
            selected
          />
        </div>
        <label className="mt-5 block text-xs font-medium">Onshape URL</label>
        <div className="mt-1.5 rounded-lg border border-input bg-background px-3 py-2 text-sm text-muted-foreground">
          https://cad.onshape.com/documents/…
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Paste a Document, Assembly, or Part Studio URL. You’ll choose which CAD to download next.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rounded-md border border-border px-3 py-2 text-xs">
            Cancel
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="rounded-md bg-foreground px-3 py-2 text-xs text-background"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function ChoiceCard(props: {
  icon: React.ReactNode;
  title: string;
  description: string;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      className={`rounded-xl border p-3 text-left ${props.selected ? "border-foreground bg-muted/70" : "border-border hover:bg-muted/40"}`}
    >
      {props.icon}
      <div className="mt-3 text-sm font-medium">{props.title}</div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.description}</div>
    </button>
  );
}

function SetupWorkspace({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background px-8 py-10">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <OnshapeMark className="size-5" /> New Onshape project
        </div>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          Choose the CAD for this project
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The source stays in Onshape. Cadsense downloads the CAD you select into private app
          storage and creates a workspace for agent files.
        </p>
        <div className="mt-8 grid grid-cols-[220px_1fr] gap-8">
          <ol className="space-y-2 text-sm">
            <SetupStep number="1" label="Onshape URL" complete />
            <SetupStep number="2" label="Choose CAD" active />
            <SetupStep number="3" label="Download" />
          </ol>
          <section className="rounded-2xl border border-border bg-card p-5">
            <div className="text-sm font-medium">Available CAD</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Select one or more scene roots. Nested assemblies and parts are included.
            </div>
            <div className="mt-5 space-y-2">
              {ROOTS.map((root, index) => (
                <label
                  key={root}
                  className="flex items-center gap-3 rounded-xl border border-border p-3"
                >
                  <span
                    className={`grid size-5 place-items-center rounded border ${index === 0 ? "border-foreground bg-foreground text-background" : "border-input"}`}
                  >
                    {index === 0 ? <Check className="size-3.5" /> : null}
                  </span>
                  <Box className="size-4 text-muted-foreground" />
                  <span className="flex-1 text-sm">{root}</span>
                  <span className="text-xs text-muted-foreground">
                    {index === 0 ? "Assembly" : "Part Studio"}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-5 flex justify-between">
              <button type="button" className="rounded-md border border-border px-3 py-2 text-xs">
                Back
              </button>
              <button
                type="button"
                onClick={onContinue}
                className="rounded-md bg-foreground px-3 py-2 text-xs text-background"
              >
                Create and download
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SetupStep(props: { number: string; label: string; active?: boolean; complete?: boolean }) {
  return (
    <li
      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${props.active ? "bg-muted font-medium" : "text-muted-foreground"}`}
    >
      <span
        className={`grid size-6 place-items-center rounded-full border text-xs ${props.complete ? "border-success bg-success text-white" : "border-border"}`}
      >
        {props.complete ? <Check className="size-3.5" /> : props.number}
      </span>
      {props.label}
    </li>
  );
}

function InlineSetup({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="py-8 text-center">
      <OnshapeMark className="mx-auto size-10" />
      <h1 className="mt-4 text-2xl font-semibold">Start an Onshape project</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Paste an Onshape URL. Cadsense will create the project and ask which CAD you want
        downloaded.
      </p>
      <div className="mx-auto mt-6 flex max-w-xl items-center rounded-xl border border-input bg-card p-2 text-left text-sm text-muted-foreground shadow-sm">
        <span className="min-w-0 flex-1 truncate px-2">https://cad.onshape.com/documents/…</span>
        <button
          type="button"
          onClick={onContinue}
          className="rounded-lg bg-foreground px-3 py-2 text-xs text-background"
        >
          Continue
        </button>
      </div>
      <button
        type="button"
        className="mt-4 text-xs text-muted-foreground underline underline-offset-4"
      >
        Add a folder project instead
      </button>
    </div>
  );
}

function OnshapeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-label="Onshape" className={className}>
      <path d="M5 8.5 12.5 4l5.3 3.1-4.5 2.7-1.1-.7-3 1.8v3.6L5 17Z" fill="#00b2a9" />
      <path
        d="m14.1 11 4.6-2.7 8.3 4.8v9.1l-7.7 4.6-4.5-2.7 4.4-2.7 1.2.7 2.4-1.4v-5.2l-4.1-2.4v5.1l-4.6 2.7Z"
        fill="#2d3339"
      />
      <path d="m5 18.8 4.3-2.6 3.2 1.9v5.2l4.5 2.6-4.5 2.7L5 24.1Z" fill="#00b2a9" />
    </svg>
  );
}
