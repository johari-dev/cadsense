import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import type { CadViewState, ScopedThreadRef } from "@cadsense/contracts";
import { create } from "zustand";
import type { Project } from "../types";

/**
 * The CAD view a draft thread shows before it has a server row to save into. The draft's first
 * send carries the view in its bootstrap, and the server saves it as the new thread's view.
 */
export const useCadDraftViewStore = create<{
  views: Record<string, CadViewState>;
  set: (ref: ScopedThreadRef, view: CadViewState) => void;
  clear: (ref: ScopedThreadRef) => void;
}>()((set) => ({
  views: {},
  set: (ref, view) => set((state) => ({ views: { ...state.views, [scopedThreadKey(ref)]: view } })),
  clear: (ref) =>
    set((state) => {
      const { [scopedThreadKey(ref)]: _cleared, ...views } = state.views;
      return { views };
    }),
}));

/** The draft's view while its snapshot is still current. A sync replaces it with the server's. */
export const usableCadDraftView = (
  project: Pick<Project, "cad">,
  view: CadViewState | undefined,
): CadViewState | undefined =>
  view && project.cad?.roots.some((root) => root.current?.snapshotId === view.snapshotId)
    ? view
    : undefined;
