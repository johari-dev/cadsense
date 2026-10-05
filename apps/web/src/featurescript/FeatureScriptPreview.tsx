import type {
  CadFeatureScriptPreviewStep,
  EnvironmentId,
  FeatureScriptDialogInput,
  FeatureScriptDialogItemInput,
  FeatureScriptFailure,
  FeatureScriptPanelPreview,
  FeatureScriptPreviewStatus,
} from "@cadsense/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  Code2Icon,
  CrosshairIcon,
  EyeIcon,
  FocusIcon,
  MessageSquareIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import {
  inputExpression,
  newPickId,
  pickExpression,
  pickKind,
  pointExpression,
  type PickHit,
} from "./featureScriptDialog";
import {
  inputsChanged,
  withBase,
  withDefaultInputs,
  withoutInputs,
  withValue,
  type FeatureScriptFileSettings,
  type FeatureScriptListItem,
} from "./featureScriptPanelStore";
import { FeatureScriptViewport } from "./FeatureScriptViewport";
import type { FeatureScriptPanelRun, FeatureScriptPreviewState } from "./useFeatureScriptPreview";

const NO_BASE = "";
const FAILED: ReadonlySet<FeatureScriptPreviewStatus> = new Set(["ERROR", "INVALID", "STOPPED"]);

/** `−1,425.5 mm³`, with a real minus sign. */
export function formatVolumeChange(mm3: number): string {
  const rounded = Math.round(mm3 * 10) / 10;
  const magnitude = Math.abs(rounded).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `${rounded < 0 ? "−" : rounded > 0 ? "+" : ""}${magnitude} mm³`;
}

/** `bolt-circle.fs:41`, or just the message's file when it has no line. */
export function failureLocationLabel(failure: FeatureScriptFailure): string | null {
  const location = failure.location;
  return location ? `${location.path.split("/").at(-1)}:${location.line}` : null;
}

/** A status chip: a colored dot, the status, and how long the run took. */
export function FeatureScriptStatusPill(props: {
  readonly run: FeatureScriptPreviewState;
  readonly className?: string;
}) {
  const { latest, running, error } = props.run;
  const status = error ? "ERROR" : latest?.status;
  if (!status && !running) return null;
  const failed = status !== undefined && FAILED.has(status);
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium",
        failed ? "bg-destructive/12 text-destructive-foreground" : "bg-muted text-foreground",
        props.className,
      )}
      data-testid="featurescript-status"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          running
            ? "bg-muted-foreground/60"
            : failed
              ? "bg-destructive"
              : status === "WARNING"
                ? "bg-warning"
                : "bg-success",
        )}
      />
      {running ? "Running" : status}
      {!running && latest && !failed && latest.elapsedMs > 0 ? (
        <span className="font-normal text-muted-foreground">
          {(latest.elapsedMs / 1000).toFixed(2)} s
        </span>
      ) : null}
    </span>
  );
}

/** The markdown-style switch between the script and its preview. */
export function FeatureScriptModeToggle(props: {
  readonly mode: FeatureScriptFileSettings["mode"];
  readonly onChange: (mode: FeatureScriptFileSettings["mode"]) => void;
}) {
  return (
    <ToggleGroup
      variant="segmented"
      value={[props.mode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "code" || next === "preview") props.onChange(next);
      }}
      aria-label="Show the script or its preview"
    >
      <Toggle value="code" aria-label="Show code">
        <Code2Icon className="size-3.5" />
        Code
      </Toggle>
      <Toggle value="preview" aria-label="Show preview">
        <EyeIcon className="size-3.5" />
        Preview
      </Toggle>
    </ToggleGroup>
  );
}

export interface FeatureScriptPreviewProps {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly run: FeatureScriptPreviewState;
  readonly settings: FeatureScriptFileSettings;
  readonly updateSettings: (
    change: (current: FeatureScriptFileSettings) => FeatureScriptFileSettings,
  ) => void;
  /** STEP files in the workspace, for the base picker. */
  readonly stepFiles: readonly string[];
  /** The base the run used: the setting, or the workspace's only STEP. */
  readonly base: string | null;
  readonly onShowLine: (path: string, line: number) => void;
  readonly onAskAgent: (failure: FeatureScriptFailure) => void;
}

/** Where an input's value lives: a top-level input, or an input inside one item of a list. */
type InputSlot =
  | { readonly input: string }
  | { readonly input: string; readonly list: string; readonly item: string };

/** The input being picked for, and what a click gives it. */
type PickTarget = { readonly slot: InputSlot } & NonNullable<ReturnType<typeof pickKind>>;

const sameSlot = (a: InputSlot, b: InputSlot) =>
  a.input === b.input &&
  ("list" in a ? a.list : null) === ("list" in b ? b.list : null) &&
  ("item" in a ? a.item : null) === ("item" in b ? b.item : null);

/** `settings` with `change` applied to the values that hold `slot`. */
function updateSlot(
  settings: FeatureScriptFileSettings,
  slot: InputSlot,
  change: <Values extends FeatureScriptListItem | FeatureScriptFileSettings>(
    values: Values,
  ) => Values,
): FeatureScriptFileSettings {
  if (!("list" in slot)) return change(settings);
  const items = settings.lists?.[slot.list] ?? [];
  // The item may have gone since (removed, or the list reset); nothing to change then.
  if (!items.some((item) => item.key === slot.item)) return settings;
  return {
    ...settings,
    lists: {
      ...settings.lists,
      [slot.list]: items.map((item) => (item.key === slot.item ? change(item) : item)),
    },
  };
}

/** The values that hold `slot`, if its list item still exists. */
function slotValues(settings: FeatureScriptFileSettings, slot: InputSlot) {
  if (!("list" in slot)) return settings;
  return settings.lists?.[slot.list]?.find((item) => item.key === slot.item) ?? null;
}

/**
 * Preview mode for a `.fs` file: the model after the feature (its faces in amber) with an
 * Onshape-style dialog over it. Changing an input runs the preview again. A failure keeps the last
 * good model on screen, greyed out, under the cause and a link to its line.
 */
export function FeatureScriptPreview(props: FeatureScriptPreviewProps) {
  const { run, settings, updateSettings } = props;
  const { latest, lastGood } = run;
  const failure: FeatureScriptFailure | null = run.error
    ? { message: run.error, location: null, unsupported: false }
    : (latest?.failure ?? null);
  const failed = run.error !== null || (latest !== null && FAILED.has(latest.status));
  // Under a failure, the last good model; otherwise the newest one.
  const shown = failed && lastGood ? lastGood : (latest ?? lastGood);
  const stale = shown !== null && shown !== latest;
  // The newest run's dialog, or the last good one while the script doesn't load.
  const dialog = latest && latest.features.length > 0 ? latest : lastGood;
  const [view, setView] = useState<"after" | "before">("after");
  const [picking, setPicking] = useState<PickTarget | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [missingModel, setMissingModel] = useState<string | null>(null);
  const before = shown?.model?.before ?? null;
  const showing =
    (picking !== null && before) || (view === "before" && before) ? "before" : "after";

  useEffect(() => {
    if (picking === null) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [picking]);

  const setParameter = (slot: InputSlot, expression: string | null) =>
    updateSettings((current) =>
      updateSlot(current, slot, (values) => withValue(values, slot.input, expression)),
    );
  const pick = (hit: PickHit, add: boolean) => {
    if (picking === null) return;
    const target = picking;
    const { input } = target.slot;
    updateSettings((current) =>
      updateSlot(current, target.slot, (values) => {
        if (target.kind === "face") {
          const points = add ? [...(values.picks[input] ?? []), hit.point] : [hit.point];
          return withValue(values, input, pickExpression(points), { picks: points });
        }
        const connector = { id: newPickId(), origin: hit.point, zAxis: hit.normal };
        const connectors = add ? [...(values.points?.[input] ?? []), connector] : [connector];
        return withValue(
          values,
          input,
          pointExpression(
            connectors.map((point) => point.id),
            target.entity,
          ),
          { picks: connectors.map((point) => point.origin), points: connectors },
        );
      }),
    );
    if (!add) setPicking(null);
  };
  const updateList = (
    list: string,
    change: (items: readonly FeatureScriptListItem[]) => readonly FeatureScriptListItem[],
  ) =>
    updateSettings((current) => {
      // A list set as one expression (by the agent) starts over as items.
      const { [list]: _expression, ...parameters } = current.parameters;
      return {
        ...current,
        parameters,
        lists: { ...current.lists, [list]: change(current.lists?.[list] ?? []) },
      };
    });
  const resetInputs = () => {
    setPicking(null);
    updateSettings(withoutInputs);
  };
  const allPicks = [
    ...Object.values(settings.picks),
    ...Object.values(settings.lists ?? {}).flatMap((items) =>
      items.flatMap((item) => Object.values(item.picks)),
    ),
  ].flat();
  const emptyMessage =
    missingModel !== null && missingModel === shown?.model?.[showing]
      ? "This run's model isn't available anymore. Save or change an input to run it again."
      : !shown?.model
        ? run.running
          ? "Running the feature…"
          : latest && !failed
            ? "The feature ran but made no geometry. Pick a base STEP below, or set its inputs."
            : null
        : showing === "after" && shown.model.after === null
          ? "Nothing is left after the feature. Before shows what it started from."
          : null;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#141414]">
      <FeatureScriptViewport
        environmentId={props.environmentId}
        after={shown?.model?.after ?? null}
        before={before}
        show={showing}
        stale={stale}
        picking={picking !== null}
        onPick={pick}
        picks={allPicks}
        fitRequest={fitRequest}
        onLoadFailed={setMissingModel}
      />
      {emptyMessage ? (
        <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-xs text-muted-foreground">
          {emptyMessage}
        </div>
      ) : null}
      {dialog && (dialog.inputs.length > 0 || dialog.features.length > 1) ? (
        <FeatureDialog
          preview={dialog}
          settings={settings}
          picking={picking}
          onPick={(target) =>
            setPicking((current) =>
              current !== null && sameSlot(current.slot, target.slot) ? null : target,
            )
          }
          onSetParameter={setParameter}
          onList={(list, change) => {
            // Picking for an item that's removed would land nowhere; stop.
            setPicking((current) =>
              current && "list" in current.slot && current.slot.list === list ? null : current,
            );
            updateList(list, change);
          }}
          onFeature={(feature) => {
            setPicking(null);
            updateSettings((current) => ({ ...withDefaultInputs(current), feature }));
          }}
          onReset={() => {
            setPicking(null);
            updateSettings(withDefaultInputs);
          }}
        />
      ) : null}
      {stale ? (
        <span className="absolute top-2.5 right-2.5 inline-flex h-6 items-center rounded-md border border-border bg-background/90 px-2 text-[11px] text-muted-foreground">
          Last good run
        </span>
      ) : null}
      {picking !== null ? (
        <div className="absolute top-2.5 right-2.5 max-w-56 rounded-md border border-info/40 bg-background/90 px-2 py-1 text-[11px] text-foreground">
          {picking.kind === "face"
            ? `Click a face${showing === "before" ? " on the model before the feature" : ""}.`
            : "Click where the point goes. Its Z axis points out of the face you click."}{" "}
          Shift adds more. Esc stops.
        </div>
      ) : null}
      <div className="absolute inset-x-2.5 bottom-2.5 flex flex-col gap-2">
        {failure ? (
          <FailureBanner
            failure={failure}
            path={props.path}
            onShowLine={props.onShowLine}
            onAskAgent={props.onAskAgent}
            // A bad input or a renamed feature can fail before there's a dialog to fix it in.
            {...(inputsChanged(settings) ? { onResetInputs: resetInputs } : {})}
          />
        ) : null}
        <Footer
          preview={latest}
          failed={failed}
          base={props.base}
          stepFiles={props.stepFiles}
          // Picked faces and points belong to the old base; nearest-face queries would quietly
          // land on the new one's, so the picks go with it.
          onBase={(base) => {
            setPicking(null);
            updateSettings((current) => withBase(current, base));
          }}
          earlier={settings.before ?? []}
          onDropEarlier={() => updateSettings(({ before: _before, ...current }) => current)}
          view={before ? showing : null}
          onView={setView}
          onFit={() => setFitRequest((count) => count + 1)}
        />
      </div>
    </div>
  );
}

function FeatureDialog(props: {
  readonly preview: FeatureScriptPanelRun;
  readonly settings: FeatureScriptFileSettings;
  readonly picking: PickTarget | null;
  readonly onPick: (target: PickTarget) => void;
  readonly onSetParameter: (slot: InputSlot, expression: string | null) => void;
  readonly onList: (
    list: string,
    change: (items: readonly FeatureScriptListItem[]) => readonly FeatureScriptListItem[],
  ) => void;
  readonly onFeature: (feature: string) => void;
  readonly onReset: () => void;
}) {
  const [open, setOpen] = useState(true);
  const { preview, settings } = props;
  const typeName =
    preview.features.find((feature) => feature.name === preview.feature)?.typeName ??
    preview.feature;
  const changed =
    Object.keys(settings.parameters).length > 0 || Object.keys(settings.lists ?? {}).length > 0;
  const rows = preview.inputs.filter((input) => input.visible);
  const slotPicking = (slot: InputSlot) =>
    props.picking !== null && sameSlot(props.picking.slot, slot);
  const row = (input: FeatureScriptDialogItemInput, slot: InputSlot) => {
    const values = slotValues(settings, slot);
    return (
      <InputRow
        key={input.id}
        input={input}
        parameter={values?.parameters[input.id]}
        picks={values?.picks[input.id]?.length ?? 0}
        picking={slotPicking(slot)}
        onPick={(target) => props.onPick({ slot, ...target })}
        onSet={(expression) => props.onSetParameter(slot, expression)}
      />
    );
  };
  return (
    <div
      className="absolute top-2.5 left-2.5 flex max-h-[calc(100%-7rem)] w-72 max-w-[calc(100%-1.25rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover/95 text-xs shadow-lg"
      aria-label="Feature inputs"
      role="group"
    >
      <div
        className={cn(
          "flex h-9 shrink-0 items-center gap-1.5 px-2.5",
          rows.length > 0 && open && "border-b border-border",
        )}
      >
        {preview.features.length > 1 ? (
          <Select
            value={preview.feature ?? ""}
            onValueChange={(value) => {
              if (typeof value === "string" && value) props.onFeature(value);
            }}
          >
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="-ml-1.5 min-w-0 font-medium"
              aria-label="Feature"
            >
              <SelectValue>{typeName}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {preview.features.map((feature) => (
                <SelectItem key={feature.name} value={feature.name}>
                  {feature.typeName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="truncate font-medium text-foreground">{typeName}</span>
        )}
        <span className="flex-1" />
        {rows.length === 0 ? (
          <span className="shrink-0 text-muted-foreground">No inputs</span>
        ) : (
          <>
            {changed && open ? (
              <Button variant="ghost-muted" size="xs" onClick={props.onReset}>
                Reset
              </Button>
            ) : null}
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={open ? "Hide the inputs" : "Show the inputs"}
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
            >
              <ChevronDownIcon className={cn("transition-transform", !open && "-rotate-90")} />
            </Button>
          </>
        )}
      </div>
      {open && rows.length > 0 ? (
        <div className="min-h-0 overflow-y-auto py-1">
          {rows.map((input) =>
            input.kind === "array" ? (
              <ListInput
                key={input.id}
                input={input}
                runKeys={preview.listKeys[input.id] ?? null}
                items={settings.lists?.[input.id] ?? null}
                expression={settings.parameters[input.id] ?? null}
                onList={(change) => props.onList(input.id, change)}
                onClearExpression={() => props.onSetParameter({ input: input.id }, null)}
                row={(inner, item) => row(inner, { input: inner.id, list: input.id, item })}
              />
            ) : (
              row(input, { input: input.id })
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A list input, such as a wire's waypoints: items to add, reorder and remove, each with its own
 * inputs. The inputs come from the last run, so a new item fills in once it has run.
 */
function ListInput(props: {
  readonly input: FeatureScriptDialogInput;
  /** The keys of the items the run had, in its order; null when it ran the list as one expression. */
  readonly runKeys: readonly string[] | null;
  /** The items edited here, or null before the first edit. */
  readonly items: readonly FeatureScriptListItem[] | null;
  /** The list set as one expression (by the agent), when it hasn't been edited here. */
  readonly expression: string | null;
  readonly onList: (
    change: (items: readonly FeatureScriptListItem[]) => readonly FeatureScriptListItem[],
  ) => void;
  readonly onClearExpression: () => void;
  readonly row: (input: FeatureScriptDialogItemInput, item: string) => ReactNode;
}) {
  const { input } = props;
  const name = input.itemName ?? "Item";
  const add = () =>
    props.onList((items) => [...items, { key: newPickId(), parameters: {}, picks: {} }]);
  const move = (key: string, by: -1 | 1) =>
    props.onList((items) => {
      const from = items.findIndex((item) => item.key === key);
      const to = from + by;
      if (from < 0 || to < 0 || to >= items.length) return items;
      const next = [...items];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    });
  const remove = (key: string) => props.onList((items) => items.filter((item) => item.key !== key));
  const fromExpression = props.items === null && props.expression !== null;
  return (
    <div className="px-2.5 py-1" role="group" aria-label={input.label}>
      <div className="flex min-h-8 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{input.label}</span>
        <Button variant="outline" size="xs" onClick={add}>
          <PlusIcon />
          Add {name.toLowerCase()}
        </Button>
      </div>
      {fromExpression ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/70 px-2 py-1.5 text-muted-foreground">
          <span className="min-w-0 flex-1">
            {input.items.length} {input.items.length === 1 ? name.toLowerCase() : "items"} set by
            the agent. Adding one starts the list over.
          </span>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={`Clear ${input.label}`}
            onClick={props.onClearExpression}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {(props.items ?? []).map((item, index, items) => {
        // The run's values for this item, matched by key: after a move or removal the run's
        // order is the old one until the next run.
        const ran = props.runKeys?.indexOf(item.key) ?? -1;
        const inner = ran >= 0 ? input.items[ran] : undefined;
        return (
          <div
            key={item.key}
            className="mt-1 rounded-lg border border-border/70 bg-background/40"
            role="group"
            aria-label={`${name} ${index + 1}`}
          >
            <div className="flex h-7 items-center gap-0.5 pr-1 pl-2">
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {name} {index + 1}
              </span>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Move ${name.toLowerCase()} ${index + 1} up`}
                disabled={index === 0}
                onClick={() => move(item.key, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Move ${name.toLowerCase()} ${index + 1} down`}
                disabled={index === items.length - 1}
                onClick={() => move(item.key, 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Remove ${name.toLowerCase()} ${index + 1}`}
                onClick={() => remove(item.key)}
              >
                <XIcon />
              </Button>
            </div>
            {inner ? (
              inner.map((field) => props.row(field, item.key))
            ) : (
              <p className="px-2 pb-1.5 text-muted-foreground">Not run yet</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InputRow(props: {
  readonly input: FeatureScriptDialogItemInput;
  /** The expression the person set, if any. */
  readonly parameter: string | undefined;
  readonly picks: number;
  readonly picking: boolean;
  readonly onPick: (target: NonNullable<ReturnType<typeof pickKind>>) => void;
  readonly onSet: (expression: string | null) => void;
}) {
  const { input } = props;
  const label = (
    <span className="min-w-0 flex-1 truncate text-muted-foreground">{input.label}</span>
  );
  if (input.kind === "boolean")
    return (
      <label className="flex min-h-8 cursor-pointer items-center gap-2 px-2.5">
        {label}
        <Checkbox
          checked={input.value === "true"}
          onCheckedChange={(checked) => props.onSet(checked ? "true" : "false")}
          aria-label={input.label}
        />
      </label>
    );
  if (input.kind === "enum" && input.options.length > 0)
    return (
      <div className="flex min-h-8 items-center gap-2 px-2.5">
        {label}
        <Select
          value={input.value}
          onValueChange={(value) => {
            if (typeof value === "string") props.onSet(value);
          }}
        >
          <SelectTrigger size="xs" className="w-32 min-w-0" aria-label={input.label}>
            <SelectValue>{enumLabel(input.value)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {input.options.map((option) => (
              <SelectItem key={option} value={option}>
                {enumLabel(option)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    );
  const target = input.kind === "query" ? pickKind(input.filter) : null;
  if (target)
    return (
      <div className="flex min-h-8 items-center gap-2 px-2.5">
        {label}
        <Button
          variant={props.picking ? "secondary" : "outline"}
          size="xs"
          className={cn("max-w-32 min-w-0", props.picking && "ring-2 ring-info/60")}
          aria-pressed={props.picking}
          aria-label={`Pick ${input.label}`}
          onClick={() => props.onPick(target)}
        >
          <CrosshairIcon />
          <span className="truncate">
            {props.picking
              ? "Click the model"
              : props.picks > 0
                ? `${props.picks} ${target.kind === "point" ? (props.picks === 1 ? "point" : "points") : "picked"}`
                : props.parameter
                  ? "Set"
                  : "Pick"}
          </span>
        </Button>
        {props.parameter ? (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={`Clear ${input.label}`}
            onClick={() => props.onSet(null)}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
    );
  return (
    <div className="flex min-h-8 items-center gap-2 px-2.5">
      {label}
      <ValueField input={input} parameter={props.parameter} onSet={props.onSet} />
    </div>
  );
}

/** `BoundingType.BLIND` as `Blind`. */
const enumLabel = (option: string) => {
  const member = option.split(".").at(-1) ?? option;
  return member.charAt(0) + member.slice(1).toLowerCase().replaceAll("_", " ");
};

/** A typed value: a number with a unit, or any FeatureScript expression. Enter or blur applies it. */
function ValueField(props: {
  readonly input: FeatureScriptDialogItemInput;
  readonly parameter: string | undefined;
  readonly onSet: (expression: string | null) => void;
}) {
  const { input } = props;
  const [text, setText] = useState(input.value);
  const [editing, setEditing] = useState(false);
  // Escape blurs the field; the blur must not apply the text Escape just threw away.
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setText(input.value);
  }, [editing, input.value]);
  const commit = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (text.trim() === input.value) return;
    props.onSet(inputExpression(input.kind, text));
  };
  return (
    <Input
      size="compact"
      className="w-32"
      aria-label={input.label}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelled.current = true;
          setText(input.value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function FailureBanner(props: {
  readonly failure: FeatureScriptFailure;
  readonly path: string;
  readonly onShowLine: (path: string, line: number) => void;
  readonly onAskAgent: (failure: FeatureScriptFailure) => void;
  /** Present when the person changed inputs or picked a feature, which may be the cause. Clears both. */
  readonly onResetInputs?: () => void;
}) {
  const { failure } = props;
  const location = failure.location;
  const where = failureLocationLabel(failure);
  return (
    <div
      role="alert"
      className="flex gap-2.5 rounded-xl border border-destructive/35 bg-[rgba(44,25,25,0.96)] px-3 py-2.5 text-xs"
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="mb-2 font-mono text-[11.5px] break-words text-red-200">
          {where ? <span className="mr-1.5 whitespace-nowrap text-foreground">{where}</span> : null}
          {failure.message}
        </p>
        {failure.unsupported ? (
          <p className="mb-2 text-muted-foreground">
            The local preview can't run this yet. The script may still work in Onshape.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {location ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => props.onShowLine(location.path, location.line)}
            >
              <Code2Icon />
              Show line {location.line}
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => props.onAskAgent(failure)}>
            <MessageSquareIcon />
            {failure.unsupported ? "Ask the agent for a workaround" : "Ask the agent to fix it"}
          </Button>
          {props.onResetInputs ? (
            <Button variant="ghost" size="xs" onClick={props.onResetInputs}>
              <RotateCcwIcon />
              Reset to defaults
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** View controls, what the feature did, and the base it ran on. */
function Footer(props: {
  readonly preview: FeatureScriptPanelPreview | null;
  readonly failed: boolean;
  readonly base: string | null;
  readonly stepFiles: readonly string[];
  readonly onBase: (base: string | null) => void;
  /** Features the agent ran before this one, from its chat card. */
  readonly earlier: readonly CadFeatureScriptPreviewStep[];
  readonly onDropEarlier: () => void;
  /** Which model is showing, or null when there's no "before" to switch to. */
  readonly view: "after" | "before" | null;
  readonly onView: (view: "after" | "before") => void;
  readonly onFit: () => void;
}) {
  const { preview } = props;
  const changes = !props.failed ? preview?.changes : null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/90 px-2 py-1.5 text-xs"
      data-testid="featurescript-footer"
    >
      <span className="flex items-center gap-1">
        {props.view ? (
          <ToggleGroup
            variant="segmented"
            value={[props.view]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "after" || next === "before") props.onView(next);
            }}
            aria-label="Show the model before or after the feature"
          >
            <Toggle value="before">Before</Toggle>
            <Toggle value="after">After</Toggle>
          </ToggleGroup>
        ) : null}
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Fit the model in view"
          onClick={props.onFit}
        >
          <FocusIcon />
        </Button>
      </span>
      {preview && !props.failed ? (
        <span className="inline-flex items-center gap-1 font-medium text-success">
          <CheckIcon className="size-3.5" />
          {preview.status}
        </span>
      ) : null}
      {changes ? (
        <>
          <span className="text-muted-foreground">
            Volume <span className="text-foreground">{formatVolumeChange(changes.volumeMm3)}</span>
          </span>
          <span className="text-muted-foreground">
            <span className="text-foreground">{changes.createdFaces}</span> new{" "}
            {changes.createdFaces === 1 ? "face" : "faces"}
          </span>
        </>
      ) : null}
      <span className="ml-auto flex min-w-0 items-center gap-1 text-muted-foreground">
        {props.earlier.length > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger render={<span />}>
                after {props.earlier.length} agent{" "}
                {props.earlier.length === 1 ? "feature" : "features"}
              </TooltipTrigger>
              <TooltipPopup side="top">
                The agent's preview ran{" "}
                {props.earlier.map((step) => step.feature ?? step.path).join(", ")} first.
              </TooltipPopup>
            </Tooltip>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Run without the agent's earlier features"
              onClick={props.onDropEarlier}
            >
              <XIcon />
            </Button>
          </span>
        ) : null}
        on
        <Select
          value={props.base ?? NO_BASE}
          onValueChange={(value) => props.onBase(typeof value === "string" && value ? value : null)}
        >
          <SelectTrigger
            variant="ghost"
            size="xs"
            className="max-w-44 min-w-0"
            aria-label="Base model"
          >
            <SelectValue>
              {props.base ? props.base.split("/").at(-1) : "an empty Part Studio"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_BASE}>An empty Part Studio</SelectItem>
            {props.stepFiles.map((file) => (
              <SelectItem key={file} value={file}>
                {file}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </span>
    </div>
  );
}
