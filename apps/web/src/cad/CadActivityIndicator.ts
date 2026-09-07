export const CAD_ACTIVITY_GRACE_MS = 1_200;

/** Retain the indicator across brief tool gaps and transfers between viewer surfaces. */
export function createCadActivityIndicator() {
  const entries = new Map<
    string,
    { sources: Set<string>; timer: ReturnType<typeof setTimeout> | null }
  >();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    visible: (key: string) => entries.has(key),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observe(key: string, active: boolean, source = "panel") {
      const entry = entries.get(key);
      if (active) {
        if (entry) {
          if (entry.timer !== null) clearTimeout(entry.timer);
          entry.timer = null;
          entry.sources.add(source);
        } else {
          entries.set(key, { sources: new Set([source]), timer: null });
          notify();
        }
      } else if (entry) {
        entry.sources.delete(source);
        if (entry.sources.size > 0 || entry.timer !== null) return;
        entry.timer = setTimeout(() => {
          entries.delete(key);
          notify();
        }, CAD_ACTIVITY_GRACE_MS);
      }
    },
  };
}

export const cadActivityIndicator = createCadActivityIndicator();
