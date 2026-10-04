import type { EnvironmentId } from "@cadsense/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/** How the file panel shows one `.fs` file, kept across reloads. */
export interface FeatureScriptFileSettings {
  readonly mode: "code" | "preview";
  /** Dialog inputs the user changed: input id to FeatureScript expression. */
  readonly parameters: Readonly<Record<string, string>>;
  /** Picked points per query input, in meters, so picks can be added to. */
  readonly picks: Readonly<Record<string, readonly (readonly [number, number, number])[]>>;
  /** The workspace STEP the feature runs on, or null for none. Unset picks one automatically. */
  readonly base?: string | null;
  /** The `defineFeature` constant to preview, when the file has several. */
  readonly feature?: string;
}

export const DEFAULT_FEATURESCRIPT_SETTINGS: FeatureScriptFileSettings = {
  mode: "preview",
  parameters: {},
  picks: {},
};

/** The settings with every input back to its default and the file's first feature. */
export const withoutInputs = ({
  feature: _feature,
  ...settings
}: FeatureScriptFileSettings): FeatureScriptFileSettings => ({
  ...settings,
  parameters: {},
  picks: {},
});

export const featureScriptFileKey = (environmentId: EnvironmentId, cwd: string, path: string) =>
  JSON.stringify([environmentId, cwd, path]);

interface FeatureScriptPanelState {
  byFile: Record<string, FeatureScriptFileSettings>;
  update: (
    key: string,
    change: (current: FeatureScriptFileSettings) => FeatureScriptFileSettings,
  ) => void;
}

export const useFeatureScriptPanelStore = create<FeatureScriptPanelState>()(
  persist(
    (set) => ({
      byFile: {},
      update: (key, change) =>
        set((state) => ({
          byFile: {
            ...state.byFile,
            [key]: change(state.byFile[key] ?? DEFAULT_FEATURESCRIPT_SETTINGS),
          },
        })),
    }),
    {
      name: "cadsense:featurescript-panel:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

/** One file's settings and a setter for them. */
export function useFeatureScriptFileSettings(key: string) {
  const settings = useFeatureScriptPanelStore(
    (state) => state.byFile[key] ?? DEFAULT_FEATURESCRIPT_SETTINGS,
  );
  const update = useFeatureScriptPanelStore((state) => state.update);
  return [
    settings,
    (change: (current: FeatureScriptFileSettings) => FeatureScriptFileSettings) =>
      update(key, change),
  ] as const;
}
