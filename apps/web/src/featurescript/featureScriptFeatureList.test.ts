import type { FeatureScriptPanelPreview } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  featureList,
  rollbackAt,
  rollbackGap,
  rollbackFromGap,
  validRollback,
} from "./featureScriptFeatureList";

/**
 * The preview's feature list: the agent's earlier steps and the previewed feature, each with its
 * status from the run, and the rollback bar between them. Ways this goes wrong: statuses from a
 * run of other steps (dropped or changed since) land on the wrong rows; a run that didn't load
 * shows every step as OK; a step after one that stopped the run reads as OK; the same file twice
 * takes one status for both; a step reads as its file when the run knows its name; rows on the
 * wrong side of the bar are dimmed; a rollback kept after its steps were dropped asks the server
 * for a step that isn't there; a drag or a key press puts the bar above the base or past the end.
 */
type Step = FeatureScriptPanelPreview["steps"][number];
const ran = (path: string, typeName: string, status: Step["status"] = "OK"): Step => ({
  path,
  feature: typeName.toLowerCase(),
  typeName,
  status,
  message: status === "OK" ? null : `${typeName} failed`,
});
const before = [{ path: "agent/bolt-circle.fs" }, { path: "agent/harness.fs", feature: "harness" }];
const fullRun = {
  steps: [
    ran("agent/bolt-circle.fs", "Bolt circle"),
    ran("agent/harness.fs", "Harness", "WARNING"),
    ran("wire-run.fs", "Wire run"),
  ],
};

describe("featureList", () => {
  it("gives each earlier step and the feature its status from a run of these steps", () => {
    const list = featureList({
      before,
      path: "wire-run.fs",
      featureName: "Wire run",
      run: fullRun,
      rollback: null,
    });
    expect(list.steps.map((step) => [step.name, step.status, step.message])).toEqual([
      ["Bolt circle", "OK", null],
      ["Harness", "WARNING", "Harness failed"],
    ]);
    expect([list.feature.status, list.feature.rolledBack]).toEqual(["OK", false]);
    expect(list.steps.map((step) => step.index)).toEqual([0, 1]);
  });

  it("shows no statuses from a run of other steps", () => {
    // The person dropped the first step since; the run still has it.
    const dropped = featureList({
      before: [before[1]!],
      path: "wire-run.fs",
      featureName: "Wire run",
      run: fullRun,
      rollback: null,
    });
    expect([dropped.steps[0]!.status, dropped.feature.status]).toEqual([null, null]);
    // Another file's run, or a step that names another feature.
    const other = featureList({
      before,
      path: "other.fs",
      featureName: "Other",
      run: fullRun,
      rollback: null,
    });
    expect(other.steps.map((step) => step.status)).toEqual([null, null]);
    const renamed = featureList({
      before: [before[0]!, { path: "agent/harness.fs", feature: "other" }],
      path: "wire-run.fs",
      featureName: "Wire run",
      run: fullRun,
      rollback: null,
    });
    expect(renamed.steps.map((step) => step.status)).toEqual([null, null]);
  });

  it("shows no statuses when the run didn't load, or there is none yet", () => {
    for (const run of [{ steps: [] }, null]) {
      const list = featureList({
        before,
        path: "wire-run.fs",
        featureName: "Wire run",
        run,
        rollback: null,
      });
      expect([...list.steps.map((step) => step.status), list.feature.status]).toEqual([
        null,
        null,
        null,
      ]);
    }
  });

  it("keeps NOT_RUN for steps after one that stopped the run", () => {
    const run = {
      steps: [
        ran("agent/bolt-circle.fs", "Bolt circle", "ERROR"),
        ran("agent/harness.fs", "Harness", "NOT_RUN"),
        ran("wire-run.fs", "Wire run", "NOT_RUN"),
      ],
    };
    const list = featureList({
      before,
      path: "wire-run.fs",
      featureName: "Wire run",
      run,
      rollback: null,
    });
    expect([...list.steps.map((step) => step.status), list.feature.status]).toEqual([
      "ERROR",
      "NOT_RUN",
      "NOT_RUN",
    ]);
  });

  it("matches the same file twice by position", () => {
    const twice = [{ path: "agent/hole.fs" }, { path: "agent/hole.fs" }];
    const run = {
      steps: [
        ran("agent/hole.fs", "Hole"),
        ran("agent/hole.fs", "Hole", "ERROR"),
        ran("f.fs", "F", "NOT_RUN"),
      ],
    };
    const list = featureList({
      before: twice,
      path: "f.fs",
      featureName: "F",
      run,
      rollback: null,
    });
    expect(list.steps.map((step) => step.status)).toEqual(["OK", "ERROR"]);
  });

  it("names a step by its run, or else its feature constant, or else its file", () => {
    expect(
      featureList({
        before,
        path: "wire-run.fs",
        featureName: "Wire run",
        run: null,
        rollback: null,
      }).steps.map((step) => step.name),
    ).toEqual(["bolt-circle.fs", "harness"]);
  });

  it("dims the rows below the rollback bar", () => {
    const rolledBack = (rollback: number | null) => {
      const list = featureList({
        before,
        path: "wire-run.fs",
        featureName: "Wire run",
        run: fullRun,
        rollback,
      });
      return [...list.steps.map((step) => step.rolledBack), list.feature.rolledBack];
    };
    expect(rolledBack(null)).toEqual([false, false, false]);
    expect(rolledBack(2)).toEqual([false, false, true]);
    expect(rolledBack(1)).toEqual([false, true, true]);
    expect(rolledBack(0)).toEqual([true, true, true]);
  });

  it("names the row the bar is above", () => {
    const above = (rollback: number | null) =>
      featureList({ before, path: "wire-run.fs", featureName: "Wire run", run: fullRun, rollback })
        .rolledBackBefore;
    expect([above(null), above(0), above(1), above(2)]).toEqual([
      null,
      "Bolt circle",
      "Harness",
      "Wire run",
    ]);
  });
});

describe("validRollback", () => {
  it("keeps a rollback that still lands between the steps, and returns to the end otherwise", () => {
    expect([0, 1, 2].map((rollback) => validRollback(rollback, 2))).toEqual([0, 1, 2]);
    expect(validRollback(null, 2)).toBeNull();
    // The steps were dropped, or the bar was somewhere no step is.
    expect([validRollback(1, 0), validRollback(3, 2), validRollback(-1, 2)]).toEqual([
      null,
      null,
      null,
    ]);
    expect(validRollback(0, 0)).toBe(0);
    expect(validRollback(0.5, 2)).toBeNull();
  });
});

describe("rollback gaps", () => {
  it("numbers the gaps from just below the base to the end", () => {
    expect([0, 1, 2, null].map((rollback) => rollbackGap(rollback, 2))).toEqual([0, 1, 2, 3]);
    expect([-1, 0, 1, 2, 3, 4].map((gap) => rollbackFromGap(gap, 2))).toEqual([
      0,
      0,
      1,
      2,
      null,
      null,
    ]);
  });

  it("puts a dragged bar below every row whose middle is above the pointer", () => {
    // Two steps and the feature, rows 26 px tall from y = 100.
    const middles = [113, 139, 165];
    expect(rollbackAt(90, middles)).toBe(0);
    expect(rollbackAt(120, middles)).toBe(1);
    expect(rollbackAt(150, middles)).toBe(2);
    expect(rollbackAt(170, middles)).toBeNull();
    expect(rollbackAt(400, middles)).toBeNull();
    // No earlier steps: the bar is above the feature or at the end.
    expect([rollbackAt(0, [113]), rollbackAt(200, [113])]).toEqual([0, null]);
  });
});
