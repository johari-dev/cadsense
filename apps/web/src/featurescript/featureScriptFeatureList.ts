import type { CadFeatureScriptPreviewStep, FeatureScriptPanelPreview } from "@cadsense/contracts";

/**
 * Where the rail's rollback bar sits, as the panel run's `rollback`: after the first `n` earlier
 * steps (0: right below the base), or null at the end, where the feature previews as usual.
 */
export type Rollback = number | null;

type RanStep = FeatureScriptPanelPreview["steps"][number];

/** One row of the rail that runs: an earlier step, or the previewed feature. */
export interface FeatureListRow {
  readonly name: string;
  /** From the run, or null when it isn't a run of these steps (or none has finished). */
  readonly status: RanStep["status"] | null;
  readonly message: string | null;
  /** Below the rollback bar, so the model shown doesn't have it. */
  readonly rolledBack: boolean;
}

export interface FeatureList {
  /** The earlier steps, each with its index in `before`. */
  readonly steps: readonly (FeatureListRow & {
    readonly index: number;
    readonly step: CadFeatureScriptPreviewStep;
  })[];
  readonly feature: FeatureListRow;
  /** The name of the row right below the bar, or null at the end. */
  readonly rolledBackBefore: string | null;
}

/**
 * The rail's rows for the earlier steps `before` and the feature in `path`, named `featureName`.
 * Statuses come from `run` only when it ran exactly these steps in this order (a step that names
 * its feature must have run that one); otherwise every status is null.
 */
export function featureList(input: {
  readonly before: readonly CadFeatureScriptPreviewStep[];
  readonly path: string;
  readonly featureName: string;
  readonly run: Pick<FeatureScriptPanelPreview, "steps"> | null;
  readonly rollback: Rollback;
}): FeatureList {
  const { before, rollback } = input;
  const ranSteps = input.run?.steps ?? [];
  const sent: readonly { readonly path: string; readonly feature?: string }[] = [
    ...before,
    { path: input.path },
  ];
  const matches =
    ranSteps.length === sent.length &&
    sent.every(
      (step, i) =>
        ranSteps[i]!.path === step.path &&
        (step.feature === undefined || ranSteps[i]!.feature === step.feature),
    );
  const ran = (i: number) => (matches ? ranSteps[i] : undefined);
  const below = (i: number) => rollback !== null && i >= rollback;
  const steps = before.map((step, index) => ({
    index,
    step,
    name: ran(index)?.typeName ?? step.feature ?? step.path.split("/").at(-1) ?? step.path,
    status: ran(index)?.status ?? null,
    message: ran(index)?.message ?? null,
    rolledBack: below(index),
  }));
  const last = ran(before.length);
  return {
    steps,
    feature: {
      name: input.featureName,
      status: last?.status ?? null,
      message: last?.message ?? null,
      rolledBack: below(before.length),
    },
    rolledBackBefore:
      rollback === null
        ? null
        : (steps[rollback]?.name ?? (rollback === before.length ? input.featureName : null)),
  };
}

/** `rollback` if it still lands between `count` earlier steps, or else null: back to the end. */
export const validRollback = (rollback: Rollback, count: number): Rollback =>
  rollback !== null && Number.isInteger(rollback) && rollback >= 0 && rollback <= count
    ? rollback
    : null;

/** The bar's gap, from 0 (right below the base) to `count + 1` (the end). */
export const rollbackGap = (rollback: Rollback, count: number) => rollback ?? count + 1;

/** The rollback at gap `gap` of `count` earlier steps, kept between the base and the end. */
export const rollbackFromGap = (gap: number, count: number): Rollback =>
  gap > count ? null : Math.max(0, gap);

/**
 * Where a dragged bar lands: below every row (the earlier steps, then the feature) whose middle
 * is above the pointer. `middles` are the rows' vertical middles, in the pointer's coordinates.
 */
export const rollbackAt = (pointerY: number, middles: readonly number[]): Rollback =>
  rollbackFromGap(middles.filter((middle) => middle < pointerY).length, middles.length - 1);
