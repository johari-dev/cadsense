import { useLayoutEffect, useSyncExternalStore } from "react";
import { cadActivityIndicator } from "./CadActivityIndicator";

export function useCadActivityIndicator(key: string, active: boolean) {
  const visible = useSyncExternalStore(
    cadActivityIndicator.subscribe,
    () => cadActivityIndicator.visible(key),
    () => false,
  );
  useLayoutEffect(() => {
    cadActivityIndicator.observe(key, active);
    return () => cadActivityIndicator.observe(key, false);
  }, [key, active]);
  return active || visible;
}
