import type { EnvironmentId, FeatureScriptFailure, ScopedThreadRef } from "@cadsense/contracts";
import { CircleAlertIcon, Code2Icon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import {
  FeatureScriptModeToggle,
  FeatureScriptPreview,
  FeatureScriptStatusPill,
  failureLocationLabel,
} from "~/featurescript/FeatureScriptPreview";
import {
  featureScriptFileKey,
  inputsChanged,
  previewInputs,
  useFeatureScriptFileSettings,
  withoutInputs,
  type FeatureScriptFileSettings,
} from "~/featurescript/featureScriptPanelStore";
import { useFeatureScriptPreview } from "~/featurescript/useFeatureScriptPreview";
import { useSeedComposer } from "~/hooks/useSeedComposer";
import { useRightPanelStore } from "~/rightPanelStore";

import { EditableFileSurface } from "./EditableFileSurface";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

const isStepFile = (path: string) => /\.(?:step|stp)$/i.test(path);

/** The composer text for "Ask the agent to fix it", or for a workaround to what can't run locally. */
function fixRequest(path: string, failure: FeatureScriptFailure): string {
  const line = failure.location?.path === path ? ` at line ${failure.location.line}` : "";
  const elsewhere =
    failure.location && failure.location.path !== path
      ? ` (${failure.location.path}:${failure.location.line})`
      : "";
  return failure.unsupported
    ? `The FeatureScript preview of ${path} stops${line}${elsewhere}: ${failure.message}\nThat's something the local preview can't run yet, not a bug in the script. If the script can get the same result with operations the preview supports, change it and preview it again; otherwise tell me to check it in Onshape.`
    : `The FeatureScript preview of ${path} fails${line}${elsewhere}: ${failure.message}\nPlease fix it and preview it again.`;
}

/**
 * A `.fs` file in the file panel: its code, or a preview of what the feature does, with the
 * markdown-style toggle between them. The preview runs after every save and every input change,
 * in both modes, so the header's status is always current. Header controls render into
 * `headerSlot`.
 */
export function FeatureScriptFile(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly contents: string;
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly headerSlot: HTMLElement | null;
}) {
  const [saved, updateSettings] = useFeatureScriptFileSettings(
    featureScriptFileKey(props.environmentId, props.cwd, props.relativePath),
  );
  // The saved feature, when the last run showed the file no longer defines it (renamed, moved, or
  // mid-rename). Until it's back, runs use the first feature with its defaults; the saved inputs
  // are kept, and only dropped once the person edits the dialog.
  const [missingFeature, setMissingFeature] = useState<string | null>(null);
  const masked = saved.feature !== undefined && saved.feature === missingFeature;
  const settings = masked ? withoutInputs(saved) : saved;
  const updateInputs = useCallback(
    (change: (current: FeatureScriptFileSettings) => FeatureScriptFileSettings) =>
      updateSettings((current) =>
        change(current.feature === missingFeature ? withoutInputs(current) : current),
      ),
    [updateSettings, missingFeature],
  );
  const entries = useProjectEntriesQuery(props.environmentId, props.cwd);
  const stepFiles = useMemo(
    () =>
      (entries.data?.entries ?? [])
        .filter((entry) => entry.kind === "file" && isStepFile(entry.path))
        .map((entry) => entry.path),
    [entries.data],
  );
  // Until the person picks one, the workspace's only STEP file is the base. Wait for the file list
  // before the first run, so it doesn't run once on nothing.
  const base =
    settings.base !== undefined ? settings.base : stepFiles.length === 1 ? stepFiles[0]! : null;
  const baseKnown = settings.base !== undefined || entries.data !== null || entries.error !== null;
  const inputs = previewInputs(settings);
  const run = useFeatureScriptPreview({
    environmentId: props.environmentId,
    cwd: props.cwd,
    path: props.relativePath,
    source: baseKnown ? props.contents : null,
    parameters: inputs.parameters,
    connectors: inputs.connectors,
    listKeys: inputs.listKeys,
    before: settings.before ?? [],
    base,
    feature: settings.feature,
  });
  const latestFeatures = run.latest?.features ?? [];
  const savedFeature = saved.feature;
  useEffect(() => {
    // Runs that didn't load list no features and say nothing about it.
    if (savedFeature === undefined || latestFeatures.length === 0) return;
    setMissingFeature(
      latestFeatures.some((feature) => feature.name === savedFeature) ? null : savedFeature,
    );
  }, [latestFeatures, savedFeature]);
  // A request to reveal a line shows the code until the person switches back.
  const [handledReveal, setHandledReveal] = useState<number | null>(null);
  const revealing = props.revealLine !== null && handledReveal !== props.revealRequestId;
  const mode = revealing ? "code" : settings.mode;
  const seed = useSeedComposer(props.threadRef);
  const showLine = (path: string, line: number) => {
    if (path === props.relativePath) updateSettings((current) => ({ ...current, mode: "code" }));
    useRightPanelStore.getState().openFile(props.threadRef, path, line);
  };
  const failure = run.latest?.failure ?? null;
  const resetInputs = () => updateSettings(withoutInputs);

  return (
    <>
      {props.headerSlot
        ? createPortal(
            <>
              <FeatureScriptStatusPill run={run} />
              <FeatureScriptModeToggle
                mode={mode}
                onChange={(next) => {
                  setHandledReveal(props.revealRequestId);
                  updateSettings((current) => ({ ...current, mode: next }));
                }}
              />
            </>,
            props.headerSlot,
          )
        : null}
      {mode === "preview" ? (
        <FeatureScriptPreview
          environmentId={props.environmentId}
          path={props.relativePath}
          run={run}
          settings={settings}
          updateSettings={updateInputs}
          stepFiles={stepFiles}
          base={base}
          onShowLine={showLine}
          onAskAgent={(failure) => seed(fixRequest(props.relativePath, failure))}
        />
      ) : (
        <>
          {failure ? (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-2 border-b border-destructive/25 bg-destructive/8 px-3 py-1.5 text-xs"
            >
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1 font-mono text-[11.5px] break-words text-red-200">
                {failureLocationLabel(failure) ? (
                  <span className="mr-1.5 text-foreground">{failureLocationLabel(failure)}</span>
                ) : null}
                {failure.message}
              </p>
              {failure.location ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => showLine(failure.location!.path, failure.location!.line)}
                >
                  <Code2Icon />
                  Line {failure.location.line}
                </Button>
              ) : null}
              {/* Changed inputs, or a picked feature, can be what fails. */}
              {inputsChanged(settings) ? (
                <Button variant="ghost" size="xs" onClick={resetInputs}>
                  <RotateCcwIcon />
                  Reset to defaults
                </Button>
              ) : null}
            </div>
          ) : null}
          <EditableFileSurface
            environmentId={props.environmentId}
            cwd={props.cwd}
            relativePath={props.relativePath}
            contents={props.contents}
            revealLine={revealing ? props.revealLine : null}
            revealRequestId={props.revealRequestId}
            wordWrap={props.wordWrap}
            onPendingChange={props.onPendingChange}
          />
        </>
      )}
    </>
  );
}
