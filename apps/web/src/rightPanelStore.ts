import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import type { ScopedThreadRef } from "@cadsense/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const RIGHT_PANEL_KINDS = ["files", "file", "preview", "agents", "cad"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
    }
  | { id: "agents"; kind: "agents" }
  | { id: "cad"; kind: "cad" };

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  open: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "file">) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "file">) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const singletonSurface = (kind: "files" | "agents" | "cad"): RightPanelSurface =>
  kind === "files"
    ? { id: "files", kind }
    : kind === "cad"
      ? { id: "cad", kind }
      : { id: "agents", kind };

const normalizeRevealLine = (line: number | undefined): number | null =>
  line === undefined || !Number.isFinite(line) ? null : Math.max(1, Math.trunc(line));

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
): ThreadRightPanelState => ({
  isOpen: true,
  activeSurfaceId: surface.id,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
});

function updateThread(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef,
  update: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> {
  const key = scopedThreadKey(ref);
  const current = byThreadKey[key] ?? EMPTY_THREAD_STATE;
  const next = update(current);
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(key in byThreadKey)) return byThreadKey;
    const { [key]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  return next === current ? byThreadKey : { ...byThreadKey, [key]: next };
}

function closeSurface(current: ThreadRightPanelState, surfaceId: string): ThreadRightPanelState {
  const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
  if (index < 0) return current;
  const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
  const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
  return {
    isOpen: surfaces.length > 0 && current.isOpen,
    surfaces,
    activeSurfaceId:
      current.activeSurfaceId === surfaceId ? (fallback?.id ?? null) : current.activeSurfaceId,
  };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      openBrowser: (ref, tabId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((surface) => surface.id !== "browser:new")
              : current.surfaces;
            return upsertSurface(
              { ...current, surfaces: withoutPlaceholder },
              browserSurface(tabId),
            );
          }),
        })),
      openFile: (ref, relativePath, line) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const surfaces = current.surfaces.filter((surface) => surface.kind !== "files");
            const id = `file:${relativePath}` as const;
            const existing = surfaces.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.kind === "file" && surface.id === id,
            );
            const next: RightPanelSurface = {
              id,
              kind: "file",
              relativePath,
              revealLine: normalizeRevealLine(line),
              revealRequestId: (existing?.revealRequestId ?? 0) + 1,
            };
            return {
              isOpen: true,
              activeSurfaceId: id,
              surfaces: existing
                ? surfaces.map((surface) => (surface.id === id ? next : surface))
                : [...surfaces, next],
            };
          }),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            closeSurface(current, surfaceId),
          ),
        })),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            return surface
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId, surfaces: [surface] }
              : current;
          }),
        })),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            return {
              ...current,
              activeSurfaceId: surfaceId,
              surfaces: current.surfaces.slice(0, index + 1),
            };
          }),
        })),
      closeAllSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, () => EMPTY_THREAD_STATE),
        })),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const validIds = new Set(tabIds.map((id) => `browser:${id}`));
            const retained = current.surfaces.filter(
              (surface) =>
                surface.kind !== "preview" ||
                (surface.id !== "browser:new" && validIds.has(surface.id)),
            );
            const known = new Set(retained.map((surface) => surface.id));
            const surfaces = [
              ...retained,
              ...tabIds.filter((id) => !known.has(`browser:${id}`)).map((id) => browserSurface(id)),
            ];
            const activeSurfaceId = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            )
              ? current.activeSurfaceId
              : (surfaces[0]?.id ?? null);
            return {
              ...current,
              isOpen: activeSurfaceId !== null && current.isOpen,
              activeSurfaceId,
              surfaces,
            };
          }),
        })),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) => surface.kind !== "files" && surface.kind !== "file",
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeSurfaceId = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            )
              ? current.activeSurfaceId
              : (surfaces[0]?.id ?? null);
            return {
              ...current,
              isOpen: activeSurfaceId !== null && current.isOpen,
              activeSurfaceId,
              surfaces,
            };
          }),
        })),
      show: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) =>
            current.activeSurfaceId ? { ...current, isOpen: true } : current,
          ),
        })),
      close: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
            ...current,
            isOpen: false,
          })),
        })),
      toggleVisibility: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        })),
      toggle: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, ref, (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) return { ...current, isOpen: false };
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      removeThread: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: "cadsense:right-panel-state:v4",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  return ref ? (byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE) : EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.isOpen
    ? (state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null)
    : null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.isOpen
    ? (state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null)
    : null;
}

export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
