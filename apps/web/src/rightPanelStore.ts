import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import type { ScopedThreadRef } from "@cadsense/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * The right panel's fixed sections, in switcher order. CAD comes first so it is
 * the default on CAD projects. Agents and Browser only show while they have
 * something to show (see `resolveRightPanelSection`).
 */
export const RIGHT_PANEL_SECTIONS = ["cad", "files", "agents", "browser"] as const;
export type RightPanelSection = (typeof RIGHT_PANEL_SECTIONS)[number];

/** The file shown inside the Files section. */
export interface RightPanelFile {
  relativePath: string;
  revealLine: number | null;
  /** Bumped on every open so re-opening the same line scrolls to it again. */
  revealRequestId: number;
}

export interface ThreadRightPanelState {
  isOpen: boolean;
  /** Section the user last picked, or null to fall back to the first available one. */
  section: RightPanelSection | null;
  /** File open in Files; null shows the file tree on its own. */
  file: RightPanelFile | null;
  /** Browser session to show in Browser; null shows the thread's active session. */
  browserTabId: string | null;
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  open: (ref: ScopedThreadRef, section: Exclude<RightPanelSection, "browser">) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  closeFile: (ref: ScopedThreadRef) => void;
  /** Drops browser state for sessions that no longer exist. */
  reconcileBrowser: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  /** Drops Files state once the thread has no workspace to browse. */
  reconcileFiles: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  section: null,
  file: null,
  browserTabId: null,
};

const normalizeRevealLine = (line: number | undefined): number | null =>
  line === undefined || !Number.isFinite(line) ? null : Math.max(1, Math.trunc(line));

function isEmpty(state: ThreadRightPanelState): boolean {
  return !state.isOpen && state.section === null && state.file === null && !state.browserTabId;
}

function updateThread(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef,
  update: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> {
  const key = scopedThreadKey(ref);
  const current = byThreadKey[key] ?? EMPTY_THREAD_STATE;
  const next = update(current);
  if (next === current) return byThreadKey;
  if (isEmpty(next)) {
    if (!(key in byThreadKey)) return byThreadKey;
    const { [key]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  return { ...byThreadKey, [key]: next };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => {
      const update = (
        ref: ScopedThreadRef,
        fn: (current: ThreadRightPanelState) => ThreadRightPanelState,
      ) => set((state) => ({ byThreadKey: updateThread(state.byThreadKey, ref, fn) }));
      return {
        byThreadKey: {},
        open: (ref, section) => update(ref, (current) => ({ ...current, isOpen: true, section })),
        openBrowser: (ref, tabId) =>
          update(ref, (current) => ({
            ...current,
            isOpen: true,
            section: "browser",
            browserTabId: tabId,
          })),
        openFile: (ref, relativePath, line) =>
          update(ref, (current) => ({
            ...current,
            isOpen: true,
            section: "files",
            file: {
              relativePath,
              revealLine: normalizeRevealLine(line),
              revealRequestId: (current.file?.revealRequestId ?? 0) + 1,
            },
          })),
        closeFile: (ref) =>
          update(ref, (current) => (current.file ? { ...current, file: null } : current)),
        reconcileBrowser: (ref, tabIds) =>
          update(ref, (current) => {
            const staleTab =
              current.browserTabId !== null && !tabIds.includes(current.browserTabId);
            const staleSection = current.section === "browser" && tabIds.length === 0;
            if (!staleTab && !staleSection) return current;
            return {
              ...current,
              browserTabId: staleTab ? null : current.browserTabId,
              section: staleSection ? null : current.section,
            };
          }),
        reconcileFiles: (ref, workspaceAvailable) =>
          update(ref, (current) =>
            workspaceAvailable || (current.file === null && current.section !== "files")
              ? current
              : {
                  ...current,
                  file: null,
                  section: current.section === "files" ? null : current.section,
                },
          ),
        close: (ref) =>
          update(ref, (current) => (current.isOpen ? { ...current, isOpen: false } : current)),
        toggleVisibility: (ref) =>
          update(ref, (current) => ({ ...current, isOpen: !current.isOpen })),
        removeThread: (ref) =>
          set((state) => {
            const key = scopedThreadKey(ref);
            if (!(key in state.byThreadKey)) return state;
            const { [key]: _removed, ...rest } = state.byThreadKey;
            return { byThreadKey: rest };
          }),
      };
    },
    {
      // v5 replaced the per-thread tab list with a single section.
      name: "cadsense:right-panel-state:v5",
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

/**
 * The section to show: the picked one while it still has content, otherwise
 * the first available one in switcher order. Null when nothing is available.
 */
export function resolveRightPanelSection(
  picked: RightPanelSection | null,
  available: Readonly<Record<RightPanelSection, boolean>>,
): RightPanelSection | null {
  if (picked && available[picked]) return picked;
  return RIGHT_PANEL_SECTIONS.find((section) => available[section]) ?? null;
}
