import type { EnvironmentId, FeatureScriptFailure, ScopedThreadRef } from "@cadsense/contracts";
import { CircleAlertIcon, Code2Icon, RotateCcwIcon } from "lucide-react";
import { useMemo, useState } from "react";
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
  useFeatureScriptFileSettings,
  withoutInputs,
} from "~/featurescript/featureScriptPanelStore";
import { useFeatureScriptPreview } from "~/featurescript/useFeatureScriptPreview";
import { useSeedComposer } from "~/hooks/useSeedComposer";
import { useRightPanelStore } from "~/rightPanelStore";

import { EditableFileSurface } from "./EditableFileSurface";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

const isStepFile = (path: string) => /\.(?:step|stp)$/i.test(path);

/** The composer text for "Ask the agent to fix it". */
function fixRequest(path: string, failure: FeatureScriptFailure): string {
  const line = failure.location?.path === path ? ` at line ${failure.location.line}` : "";
  const elsewhere =
    failure.location && failure.location.path !== path
      ? ` (${failure.location.path}:${failure.location.line})`
      : "";
  return `The FeatureScript preview of ${path} fails${line}${elsewhere}: ${failure.message}\nPlease fix it and preview it again.`;
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
  const [settings, updateSettings] = useFeatureScriptFileSettings(
    featureScriptFileKey(props.environmentId, props.cwd, props.relativePath),
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
  const run = useFeatureScriptPreview({
    environmentId: props.environmentId,
    cwd: props.cwd,
    path: props.relativePath,
    source: baseKnown ? props.contents : null,
    parameters: settings.parameters,
    base,
    feature: settings.feature,
  });
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
  // Changed inputs, or a picked feature, can be what fails; resetting them is offered with the error.
  const inputsChanged =
    Object.keys(settings.parameters).length > 0 || settings.feature !== undefined;
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
          updateSettings={updateSettings}
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
              {inputsChanged ? (
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
