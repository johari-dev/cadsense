import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import type {
  CadFeatureScriptPreviewStep,
  EnvironmentId,
  FeatureScriptEditingState,
  FeatureScriptManipulatorChange,
  FeatureScriptPanelPreview,
  FeatureScriptPickedConnector,
} from "@cadsense/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
 * Runs a manipulator drag of the latest run: its "Manipulator Change Function" and then the
 * feature, with the request's inputs. `keep` gets the run that took the drag and the run it
 * started from, to keep the inputs the change set; that settings update doesn't run again. It
 * isn't called when the change failed, or when the person changed an input meanwhile, whose own
 * run follows.
 */
export type ManipulateFeatureScript = (
  change: FeatureScriptManipulatorChange,
  keep: (ran: FeatureScriptPanelRun, from: FeatureScriptPanelRun) => void,
) => void;

/**
 * Runs the file panel's preview whenever the script, an input, the base or the feature changes.
 * Text changes wait for the editor's save debounce; dialog changes run at once. Pass a null source
 * to stop (a file that isn't FeatureScript). Switching files starts over, and the debounced text
 * travels with its path, so one file's text never runs under another's name.
 */
export function useFeatureScriptPreview(
  request: FeatureScriptPreviewRequest,
): FeatureScriptPreviewState & { readonly manipulate: ManipulateFeatureScript } {
  const run = useAtomCommand(featureScriptEnvironment.preview, { reportFailure: false });
  const fileKey = JSON.stringify([request.environmentId, request.cwd, request.path]);
  const edit = useMemo(() => ({ fileKey, source: request.source }), [fileKey, request.source]);
  const settled = useDebouncedValue(edit, SOURCE_DEBOUNCE_MS);
  const source = settled.fileKey === fileKey ? settled.source : null;
  const [state, setState] = useState({ fileKey, ...IDLE });
  const requested = useRef(0);
  const applied = useRef(0);
  // Inputs arrive as new objects each render; their text decides when to run again.
  const inputsKey = JSON.stringify([
    request.parameters,
    request.connectors,
    request.before,
    request.listKeys,
    request.edits,
  ]);
  const { environmentId, cwd, path, base, feature } = request;
  /** What the next run sends; the editing state and touched inputs ride along without running. */
  const current = useRef({ ...request, fileKey, source, inputsKey, latest: state.latest });
  current.current = {
    ...request,
    fileKey,
    source,
    inputsKey,
    latest: state.fileKey === fileKey ? state.latest : null,
  };
  /**
   * Set while the inputs a drag's run set are being kept, to what else that run sent: the input
   * change that follows has already run, unless something else changed with it.
   */
  const kept = useRef<
    | (Pick<typeof request, "base" | "feature"> & {
        readonly fileKey: string;
        readonly source: string;
      })
    | null
  >(null);

  const send = useCallback(
    (
      manipulation: {
        readonly change: FeatureScriptManipulatorChange;
        readonly keep: Parameters<ManipulateFeatureScript>[1];
      } | null,
    ) => {
      const sent = current.current;
      const { source } = sent;
      if (source === null) return;
      const id = ++requested.current;
      const { fileKey } = sent;
      const from = sent.latest;
      setState((state) =>
        state.fileKey === fileKey
          ? { ...state, running: true }
          : { fileKey, ...IDLE, running: true },
      );
      const [parameters, connectors, before, listKeys] = JSON.parse(sent.inputsKey) as [
        FeatureScriptPreviewRequest["parameters"],
        FeatureScriptPreviewRequest["connectors"],
        FeatureScriptPreviewRequest["before"],
        FeatureScriptPreviewRequest["listKeys"],
      ];
      void run({
        environmentId: sent.environmentId,
        input: {
          cwd: sent.cwd,
          path: sent.path,
          source,
          parameters,
          ...(connectors.length > 0 ? { connectors } : {}),
          ...(before.length > 0 ? { before } : {}),
          ...(sent.base === null ? {} : { base: sent.base }),
          ...(sent.feature === undefined ? {} : { feature: sent.feature }),
          editing: sent.editing,
          ...(sent.touched.length > 0 ? { touched: sent.touched } : {}),
          ...(manipulation ? { manipulatorChange: manipulation.change } : {}),
        },
      }).then((result) => {
        // Runs coalesce, so superseded calls resolve with the newest result; never go backwards.
        if (id < applied.current) return;
        applied.current = id;
        const running = id !== requested.current;
        // A superseded call resolves with a newer run, so its keys can lag until that run's own
        // call resolves right after.
        const latest = result._tag === "Success" ? { ...result.value, listKeys } : null;
        if (
          manipulation &&
          latest?.parameters &&
          from &&
          !running &&
          current.current.fileKey === fileKey &&
          current.current.inputsKey === sent.inputsKey
        ) {
          kept.current = { fileKey, source, base: sent.base, feature: sent.feature };
          manipulation.keep(latest, from);
        }
        setState((state) =>
          state.fileKey !== fileKey
            ? state
            : latest
              ? {
                  fileKey,
                  latest,
                  lastGood: worked(latest) ? latest : state.lastGood,
                  running,
                  error: null,
                }
              : result._tag === "Success" || isAtomCommandInterrupted(result)
                ? { ...state, running }
                : { ...state, running, error: failureText(squashAtomCommandFailure(result)) },
        );
      });
    },
    [run],
  );

  useEffect(() => {
    if (source === null) return;
    const skip = kept.current;
    kept.current = null;
    if (
      skip?.fileKey === fileKey &&
      skip.source === source &&
      skip.base === base &&
      skip.feature === feature
    )
      return;
    send(null);
  }, [send, environmentId, cwd, path, fileKey, source, inputsKey, base, feature]);

  const manipulate = useCallback<ManipulateFeatureScript>(
    (change, keep) => send({ change, keep }),
    [send],
  );
  if (state.fileKey === fileKey) return { ...state, manipulate };
  return { ...IDLE, running: request.source !== null, manipulate };
}
