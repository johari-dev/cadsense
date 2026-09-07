export const CAD_ACTIVITY_GRACE_MS = 1_200;

/** Retain the indicator across brief tool gaps and transfers between viewer surfaces. */
export function createCadActivityIndicator() {
  const entries = new Map<string, ReturnType<typeof setTimeout> | null>();
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
    observe(key: string, active: boolean) {
      const timer = entries.get(key);
      if (active) {
        if (timer != null) clearTimeout(timer);
        const wasVisible = entries.has(key);
        entries.set(key, null);
        if (!wasVisible) notify();
      } else if (timer === null) {
        entries.set(
          key,
          setTimeout(() => {
            entries.delete(key);
            notify();
          }, CAD_ACTIVITY_GRACE_MS),
        );
      }
    },
  };
}

export const cadActivityIndicator = createCadActivityIndicator();
