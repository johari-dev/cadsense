import type {
  CadFeatureScriptPreviewStep,
  EnvironmentId,
  FeatureScriptPickedConnector,
} from "@cadsense/contracts";
import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { listExpression, type ModelPoint } from "./featureScriptDialog";

/** Inputs set by typing or picking: input id to FeatureScript expression, and the picks behind it. */
interface InputValues {
  readonly parameters: Readonly<Record<string, string>>;
  /** Picked face points per input, in meters, so picks can be added to. */
  readonly picks: Readonly<Record<string, readonly ModelPoint[]>>;
  /** Picked points per input, made into mate connectors at each run. */
  readonly points?: Readonly<Record<string, readonly FeatureScriptPickedConnector[]>>;
}

/** One item of a list input, edited in the dialog. `key` stays put when items move. */
export interface FeatureScriptListItem extends InputValues {
  readonly key: string;
}

/** How the file panel shows one `.fs` file, kept across reloads. */
export interface FeatureScriptFileSettings extends InputValues {
  readonly mode: "code" | "preview";
  /** List inputs edited item by item; each is sent as one expression. */
  readonly lists?: Readonly<Record<string, readonly FeatureScriptListItem[]>>;
  /** The workspace STEP the feature runs on, or null for none. Unset picks one automatically. */
  readonly base?: string | null;
  /** The `defineFeature` constant to preview, when the file has several. */
  readonly feature?: string;
  /** Features the agent ran first, from the chat card that opened the file. */
  readonly before?: readonly CadFeatureScriptPreviewStep[];
}

export const DEFAULT_FEATURESCRIPT_SETTINGS: FeatureScriptFileSettings = {
  mode: "preview",
  parameters: {},
  picks: {},
};

/** The settings with every input back to its default, for the same feature. */
export const withDefaultInputs = ({
  points: _points,
  lists: _lists,
  ...settings
}: FeatureScriptFileSettings): FeatureScriptFileSettings => ({
  ...settings,
  parameters: {},
  picks: {},
});

/** The settings with every input back to its default and the file's first feature. */
export const withoutInputs = ({
  feature: _feature,
  ...settings
}: FeatureScriptFileSettings): FeatureScriptFileSettings => withDefaultInputs(settings);

/** Whether the person changed any input or picked a feature, either of which can be what fails. */
export const inputsChanged = (settings: FeatureScriptFileSettings) =>
  Object.keys(settings.parameters).length > 0 ||
  Object.keys(settings.lists ?? {}).length > 0 ||
  settings.feature !== undefined;

/** `values` with input `id` set to `expression` (null for its default), its earlier picks dropped. */
export function withValue<Values extends InputValues>(
  values: Values,
  id: string,
  expression: string | null,
  picked: {
    readonly picks?: readonly ModelPoint[];
    readonly points?: readonly FeatureScriptPickedConnector[];
  } = {},
): Values {
  const { [id]: _parameter, ...parameters } = values.parameters;
  const { [id]: _picks, ...picks } = values.picks;
  const { [id]: _points, ...points } = values.points ?? {};
  return {
    ...values,
    parameters: expression === null ? parameters : { ...parameters, [id]: expression },
    picks: picked.picks ? { ...picks, [id]: picked.picks } : picks,
    points: picked.points ? { ...points, [id]: picked.points } : points,
  };
}

/** `values` without the inputs set by picking, which belong to the base they were picked on. */
function withoutPicked<Values extends InputValues>(values: Values): Values {
  const picked = new Set([...Object.keys(values.picks), ...Object.keys(values.points ?? {})]);
  return {
    ...values,
    parameters: Object.fromEntries(
      Object.entries(values.parameters).filter(([id]) => !picked.has(id)),
    ),
    picks: {},
    points: {},
  };
}

/** The settings on another base: picked inputs, in lists too, go with the old one. */
export const withBase = (
  settings: FeatureScriptFileSettings,
  base: string | null,
): FeatureScriptFileSettings => ({
  ...withoutPicked(settings),
  base,
  lists: Object.fromEntries(
    Object.entries(settings.lists ?? {}).map(([id, items]) => [id, items.map(withoutPicked)]),
  ),
});

/**
 * What a run sends for these settings: lists as expressions, and every picked point. `listKeys`
 * stays here: each list's item keys in the order sent, to match the run's items back to them.
 */
export function previewInputs(settings: FeatureScriptFileSettings): {
  readonly parameters: Readonly<Record<string, string>>;
  readonly connectors: readonly FeatureScriptPickedConnector[];
  readonly listKeys: Readonly<Record<string, readonly string[]>>;
} {
  const lists = Object.entries(settings.lists ?? {});
  return {
    parameters: {
      ...settings.parameters,
      ...Object.fromEntries(
        lists.map(([id, items]) => [id, listExpression(items.map((item) => item.parameters))]),
      ),
    },
    connectors: [
      ...Object.values(settings.points ?? {}),
      ...lists.flatMap(([, items]) => items.flatMap((item) => Object.values(item.points ?? {}))),
    ].flat(),
    listKeys: Object.fromEntries(lists.map(([id, items]) => [id, items.map((item) => item.key)])),
  };
}

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
  const updateFile = useCallback(
    (change: (current: FeatureScriptFileSettings) => FeatureScriptFileSettings) =>
      update(key, change),
    [update, key],
  );
  return [settings, updateFile] as const;
}
