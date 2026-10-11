import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import type { CadViewState, ScopedThreadRef } from "@cadsense/contracts";
import { create } from "zustand";

/**
 * Which location of a comment is focused: an index into its targets, or "all" to frame every
 * location at once. A single-location comment treats "all" as its only location.
 */
export type CadCommentLocation = number | "all";

export interface CadPanelReviewSession {
  readonly commentsOpen: boolean;
  readonly selection: { id: string; target: CadCommentLocation; request: number } | null;
  readonly historicalView: CadViewState | null;
  readonly savedCurrent: {
    view: CadViewState;
    descriptor: string | null;
    framing: { x: number; y: number };
  } | null;
  readonly localFraming: { x: number; y: number } | null;
  readonly localView: CadViewState | null;
}
export const EMPTY_CAD_PANEL_REVIEW: CadPanelReviewSession = {
  commentsOpen: false,
  selection: null,
  historicalView: null,
  savedCurrent: null,
  localFraming: null,
  localView: null,
};
const MAX_REVIEW_SESSIONS = 64;

/** Review intent survives panel unmounts without persisting model data or server leases. */
export const useCadCommentReviewStore = create<{
  pending: Record<string, { id: string; target: CadCommentLocation } | null>;
  sessions: Record<string, CadPanelReviewSession>;
  sessionOrder: readonly string[];
  updateSession: (
    ref: ScopedThreadRef,
    update: (current: CadPanelReviewSession) => CadPanelReviewSession,
  ) => void;
  request: (ref: ScopedThreadRef, target?: { id: string; target: CadCommentLocation }) => void;
  consume: (ref: ScopedThreadRef) => void;
}>()((set) => ({
  pending: {},
  sessions: {},
  sessionOrder: [],
  updateSession: (ref, update) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const sessions = {
        ...state.sessions,
        [key]: update(state.sessions[key] ?? EMPTY_CAD_PANEL_REVIEW),
      };
      const sessionOrder = [...state.sessionOrder.filter((entry) => entry !== key), key];
      while (sessionOrder.length > MAX_REVIEW_SESSIONS) delete sessions[sessionOrder.shift()!];
      return { sessions, sessionOrder };
    }),
  request: (ref, target) =>
    set((state) => ({ pending: { ...state.pending, [scopedThreadKey(ref)]: target ?? null } })),
  consume: (ref) =>
    set((state) => {
      const { [scopedThreadKey(ref)]: _consumed, ...pending } = state.pending;
      return { pending };
    }),
}));
