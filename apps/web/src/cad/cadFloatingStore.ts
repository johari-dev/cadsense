import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import type { ScopedThreadRef } from "@cadsense/contracts";
import { create } from "zustand";

interface FloatingCadState {
  visible: boolean;
  dismissedTurn: string | null;
}

export const useCadFloatingStore = create<{
  byThread: Record<string, FloatingCadState>;
  observe: (ref: ScopedThreadRef, turnId: string, inPanel: boolean) => void;
  dismiss: (ref: ScopedThreadRef, turnId: string | null) => void;
}>()((set) => ({
  byThread: {},
  observe: (ref, turnId, inPanel) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const current = state.byThread[key];
      const visible = !inPanel && current?.dismissedTurn !== turnId;
      const dismissedTurn = inPanel ? turnId : (current?.dismissedTurn ?? null);
      if (current?.visible === visible && current.dismissedTurn === dismissedTurn) return state;
      return { byThread: { ...state.byThread, [key]: { visible, dismissedTurn } } };
    }),
  dismiss: (ref, turnId) =>
    set((state) => ({
      byThread: {
        ...state.byThread,
        [scopedThreadKey(ref)]: { visible: false, dismissedTurn: turnId },
      },
    })),
}));
