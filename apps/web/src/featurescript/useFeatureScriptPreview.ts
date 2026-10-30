import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import type {
  CadFeatureScriptPreviewStep,
  EnvironmentId,
  FeatureScriptEditingState,
  FeatureScriptPanelPreview,
  FeatureScriptPickedConnector,
} from "@cadsense/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { featureScriptEnvironment } from "../state/featurescript";
import { useDebouncedValue } from "../state/queries";
import { useAtomCommand } from "../state/use-atom-command";

/** Matches the editor's save debounce, so a run follows each save. */
const SOURCE_DEBOUNCE_MS = 500;

export interface FeatureScriptPreviewRequest {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  /** The editor's text, null while the file loads. */
  readonly source: string | null;
  readonly parameters: Readonly<Record<string, string>>;
  /** Points picked in the preview, made into mate connectors before the features run. */
  readonly connectors: readonly FeatureScriptPickedConnector[];
  /** Each edited list's item keys in the order sent; see {@link FeatureScriptPanelRun}. */
  readonly listKeys: Readonly<Record<string, readonly string[]>>;
  /** Features to run first, from disk: the agent's, when its chat card opened the file. */
  readonly before: readonly CadFeatureScriptPreviewStep[];
  readonly base: string | null;
  readonly feature: string | undefined;
  /**
   * The dialog state the last run returned, null when the dialog is fresh. Sent with each run, but
   * storing a run's new state doesn't run it again.
   */
  readonly editing: FeatureScriptEditingState | null;
  /** Inputs the person set since that state's run; sent with each run, like `editing`. */
  readonly touched: readonly string[];
  /** Counts the person's edits: each one runs again, even when it left every input's text alone. */
  readonly edits: number;
}

/**
 * A finished run, with the item keys of each list it ran, so the dialog shows an item's values from
 * the run even after the items move or go.
 */
export type FeatureScriptPanelRun = FeatureScriptPanelPreview & {
  readonly listKeys: Readonly<Record<string, readonly string[]>>;
};

export interface FeatureScriptPreviewState {
  /** The newest finished run. */
  readonly latest: FeatureScriptPanelRun | null;
  /** The newest run that worked and drew something, shown greyed out under a failure. */
  readonly lastGood: FeatureScriptPanelRun | null;
  readonly running: boolean;
  /** The request itself failed: a base file that's gone, the server unreachable. */
  readonly error: string | null;
}

const worked = (preview: FeatureScriptPanelPreview) =>
  preview.model !== null &&
  (preview.status === "OK" || preview.status === "INFO" || preview.status === "WARNING");

const failureText = (failure: unknown) =>
  typeof failure === "object" &&
  failure !== null &&
  "details" in failure &&
  typeof failure.details === "string"
    ? failure.details
    : failure instanceof Error
      ? failure.message
      : "The preview couldn't run.";

const IDLE: FeatureScriptPreviewState = {
  latest: null,
  lastGood: null,
  running: false,
  error: null,
};

/**
 * Runs the file panel's preview whenever the script, an input, the base or the feature changes.
 * Text changes wait for the editor's save debounce; dialog changes run at once. Pass a null source
 * to stop (a file that isn't FeatureScript). Switching files starts over, and the debounced text
 * travels with its path, so one file's text never runs under another's name.
 */
export function useFeatureScriptPreview(
  request: FeatureScriptPreviewRequest,
): FeatureScriptPreviewState {
  const run = useAtomCommand(featureScriptEnvironment.preview, { reportFailure: false });
  const fileKey = JSON.stringify([request.environmentId, request.cwd, request.path]);
  const edit = useMemo(() => ({ fileKey, source: request.source }), [fileKey, request.source]);
  const settled = useDebouncedValue(edit, SOURCE_DEBOUNCE_MS);
  const source = settled.fileKey === fileKey ? settled.source : null;
  const [state, setState] = useState({ fileKey, ...IDLE });
  const requested = useRef(0);
  const applied = useRef(0);
  const editing = useRef(request.editing);
  editing.current = request.editing;
  const touched = useRef(request.touched);
  touched.current = request.touched;
  // Inputs arrive as new objects each render; their text decides when to run again.
  const inputsKey = JSON.stringify([
    request.parameters,
    request.connectors,
    request.before,
    request.listKeys,
    request.edits,
  ]);
  const { environmentId, cwd, path, base, feature } = request;

  useEffect(() => {
    if (source === null) return;
    const id = ++requested.current;
    setState((current) =>
      current.fileKey === fileKey
        ? { ...current, running: true }
        : { fileKey, ...IDLE, running: true },
    );
    const [parameters, connectors, before, listKeys] = JSON.parse(inputsKey) as [
      FeatureScriptPreviewRequest["parameters"],
      FeatureScriptPreviewRequest["connectors"],
      FeatureScriptPreviewRequest["before"],
      FeatureScriptPreviewRequest["listKeys"],
    ];
    void run({
      environmentId,
      input: {
        cwd,
        path,
        source,
        parameters,
        ...(connectors.length > 0 ? { connectors } : {}),
        ...(before.length > 0 ? { before } : {}),
        ...(base === null ? {} : { base }),
        ...(feature === undefined ? {} : { feature }),
        editing: editing.current,
        ...(touched.current.length > 0 ? { touched: touched.current } : {}),
      },
    }).then((result) => {
      // Runs coalesce, so superseded calls resolve with the newest result; never go backwards.
      if (id < applied.current) return;
      applied.current = id;
      const running = id !== requested.current;
      setState((current) =>
        current.fileKey !== fileKey
          ? current
          : result._tag === "Success"
            ? (() => {
                // A superseded call resolves with a newer run, so its keys can lag until that
                // run's own call resolves right after.
                const latest = { ...result.value, listKeys };
                return {
                  fileKey,
                  latest,
                  lastGood: worked(latest) ? latest : current.lastGood,
                  running,
                  error: null,
                };
              })()
            : isAtomCommandInterrupted(result)
              ? { ...current, running }
              : { ...current, running, error: failureText(squashAtomCommandFailure(result)) },
      );
    });
  }, [run, environmentId, cwd, path, fileKey, source, inputsKey, base, feature]);

  if (state.fileKey === fileKey) return state;
  return { ...IDLE, running: request.source !== null };
}
