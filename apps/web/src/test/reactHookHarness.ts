import type { DependencyList, Dispatch, EffectCallback, SetStateAction } from "react";

interface EffectSlot {
  readonly _tag: "EffectSlot";
  readonly dependencies: DependencyList | undefined;
  readonly cleanup: void | (() => void);
}

interface ExternalStoreSlot {
  readonly _tag: "ExternalStoreSlot";
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => unknown;
  cleanup: () => void;
  snapshot: unknown;
}

function isEffectSlot(value: unknown): value is EffectSlot {
  return (
    typeof value === "object" && value !== null && "_tag" in value && value._tag === "EffectSlot"
  );
}

function isExternalStoreSlot(value: unknown): value is ExternalStoreSlot {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "ExternalStoreSlot"
  );
}

/**
 * Minimal React hook shim for tests that call components as plain functions
 * instead of mounting a renderer. Slots are keyed by call order, mirroring
 * React's own rules-of-hooks contract, and `useMemoCache` emulates the React
 * Compiler runtime so compiled components can execute unmodified.
 *
 * This module must stay free of runtime `react` imports: it is loaded from
 * inside `vi.mock("react", ...)` factories, and a value import would recurse
 * into the in-progress mock. Wire it up in each test file (mock calls cannot
 * live here because vitest hoists them per test module):
 *
 * ```ts
 * import { reactHookHarness } from "~/test/reactHookHarness";
 *
 * vi.mock("react", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("react")>();
 *   const { reactHookHarness } = await import("~/test/reactHookHarness");
 *   return {
 *     ...actual,
 *     useCallback: reactHookHarness.useCallback,
 *     useMemo: reactHookHarness.useMemo,
 *     useRef: reactHookHarness.useRef,
 *     useState: reactHookHarness.useState,
 *   };
 * });
 * vi.mock("react/compiler-runtime", async () => {
 *   const { reactHookHarness } = await import("~/test/reactHookHarness");
 *   return { c: reactHookHarness.useMemoCache };
 * });
 * ```
 *
 * Call `beginRender()` before each component invocation and `reset()` in
 * `beforeEach` to drop persisted state between tests.
 */
export function createReactHookHarness() {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      for (const slot of slots) {
        if (isEffectSlot(slot)) slot.cleanup?.();
        if (isExternalStoreSlot(slot)) slot.cleanup();
      }
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useEffect(effect: EffectCallback, dependencies?: DependencyList): void {
      const index = nextIndex();
      const previous = slots[index];
      const unchanged =
        isEffectSlot(previous) &&
        dependencies !== undefined &&
        previous.dependencies !== undefined &&
        dependencies.length === previous.dependencies.length &&
        dependencies.every((dependency, dependencyIndex) =>
          Object.is(dependency, previous.dependencies?.[dependencyIndex]),
        );
      if (unchanged) return;
      if (isEffectSlot(previous)) previous.cleanup?.();
      slots[index] = {
        _tag: "EffectSlot",
        dependencies,
        cleanup: effect(),
      } satisfies EffectSlot;
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
    useSyncExternalStore<T>(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T,
    ): T {
      const index = nextIndex();
      const previous = slots[index];
      if (
        !isExternalStoreSlot(previous) ||
        previous.subscribe !== subscribe ||
        previous.getSnapshot !== getSnapshot
      ) {
        if (isExternalStoreSlot(previous)) previous.cleanup();
        const slot: ExternalStoreSlot = {
          _tag: "ExternalStoreSlot",
          subscribe,
          getSnapshot,
          cleanup: () => undefined,
          snapshot: getSnapshot(),
        };
        slot.cleanup = subscribe(() => {
          slot.snapshot = getSnapshot();
        });
        slots[index] = slot;
      } else {
        previous.snapshot = getSnapshot();
      }
      return (slots[index] as ExternalStoreSlot).snapshot as T;
    },
  };
}

/** Shared instance so `vi.mock` factories and test bodies see the same slots. */
export const reactHookHarness = createReactHookHarness();
