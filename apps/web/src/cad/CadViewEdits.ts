import type { CadViewState } from "@cadsense/contracts";

/** Immediate presentation with serialized, latest-wins persistence per mounted thread. */
export function createCadViewEdits(
  save: (view: CadViewState, expectedRevision: number | null) => Promise<CadViewState>,
  onError: () => void,
) {
  let revision: number | null = null;
  let observedRevision: number | null = null;
  let locked = true;
  let saving = false;
  let queued: CadViewState | null = null;
  let optimistic: CadViewState | null = null;
  const listeners = new Set<() => void>();
  const publish = (view: CadViewState | null) => {
    optimistic = view;
    for (const listener of listeners) listener();
  };
  const drain = async () => {
    if (saving) return;
    saving = true;
    try {
      while (queued) {
        if (locked) break;
        const next = queued;
        queued = null;
        const saved = await save(
          { ...next, revision: revision === null ? 0 : revision + 1 },
          revision,
        );
        revision = saved.revision;
      }
      if (observedRevision !== null && revision !== null && observedRevision >= revision)
        publish(null);
    } catch {
      queued = null;
      revision = observedRevision;
      publish(null);
      onError();
    } finally {
      saving = false;
    }
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => optimistic,
    observe: (nextRevision: number | null, nextLocked: boolean) => {
      observedRevision = nextRevision;
      locked = nextLocked;
      if (locked) {
        queued = null;
        if (optimistic) publish(null);
      }
      if (!saving && (revision === null || (nextRevision !== null && nextRevision >= revision))) {
        revision = nextRevision;
        if (optimistic) publish(null);
      }
    },
    select: (view: CadViewState) => {
      if (locked) return;
      queued = view;
      publish(view);
      void drain();
    },
  };
}
