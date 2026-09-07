import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import type { ScopedThreadRef } from "@cadsense/contracts";
import { create } from "zustand";

/** One-shot handoff from the floating viewer to the docked comments card. */
export const useCadCommentReviewStore = create<{
  pending: Record<string, { id: string; target: number } | null>;
  request: (ref: ScopedThreadRef, target?: { id: string; target: number }) => void;
  consume: (ref: ScopedThreadRef) => void;
}>()((set) => ({
  pending: {},
  request: (ref, target) =>
    set((state) => ({ pending: { ...state.pending, [scopedThreadKey(ref)]: target ?? null } })),
  consume: (ref) =>
    set((state) => {
      const { [scopedThreadKey(ref)]: _consumed, ...pending } = state.pending;
      return { pending };
    }),
}));
