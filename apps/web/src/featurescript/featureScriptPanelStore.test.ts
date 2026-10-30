import type { FeatureScriptDialogInput, FeatureScriptDialogItemInput } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FEATURESCRIPT_SETTINGS,
  previewInputs,
  withDefaultInputs,
  withManipulated,
  withRunEditing,
  withTouched,
  withValue,
  type FeatureScriptFileSettings,
} from "./featureScriptPanelStore";

/**
 * The dialog's editing-logic state in the panel's settings. Ways this goes wrong: setting an input
 * to the text it already had (after the editing logic overrode it) changes nothing, so no run
 * starts and the logic's value stays; the server isn't told which inputs were set; a run's state
 * is stored but the inputs it took stay marked, so a later run takes them back again; storing an
 * unchanged state starts a run; a reset keeps the old dialog's state.
 */
describe("editing state in the panel's settings", () => {
  const logicState = {
    parameters: { depth: "10 * millimeter" },
    edited: { depth: "0.014 * meter" },
  };

  it("marks an input set again, even to the same text, and counts the edit", () => {
    const set = withValue(
      { ...DEFAULT_FEATURESCRIPT_SETTINGS, parameters: { depth: "10 * millimeter" } },
      "depth",
      "10 * millimeter",
    );
    expect(set.parameters).toEqual({ depth: "10 * millimeter" });
    const touched = withTouched(withTouched(set, "depth"), "depth");
    expect(touched.touched).toEqual(["depth"]);
    expect(touched.edits).toBe(2);
  });

  it("stores a run's state and forgets what that run took", () => {
    const touched = withTouched(
      { ...DEFAULT_FEATURESCRIPT_SETTINGS, parameters: logicState.parameters, editing: logicState },
      "depth",
    );
    const stored = withRunEditing(touched, { parameters: logicState.parameters, edited: {} });
    expect(stored.editing).toEqual({ parameters: logicState.parameters, edited: {} });
    expect(stored.touched).toBeUndefined();
    // The count of edits, which starts runs, doesn't move.
    expect(stored.edits).toBe(touched.edits);
    // A run without editing logic clears it.
    expect(withRunEditing(stored, null).editing).toBeUndefined();
    // Nothing to store: the same settings, so nothing re-renders or runs.
    expect(withRunEditing(stored, stored.editing!)).toBe(stored);
  });

  it("keeps no state from a run of inputs the dialog has left, such as one from before a reset", () => {
    const reset = withDefaultInputs({
      ...DEFAULT_FEATURESCRIPT_SETTINGS,
      editing: logicState,
      parameters: logicState.parameters,
    });
    expect(withRunEditing(reset, logicState)).toBe(reset);
    // A run of the inputs on screen is kept, lists counted as their expressions.
    const listed = {
      ...DEFAULT_FEATURESCRIPT_SETTINGS,
      lists: { waypoints: [{ key: "a", parameters: { z: "1 * millimeter" }, picks: {} }] },
    };
    const ran = { parameters: { waypoints: '[{ "z" : 1 * millimeter }]' }, edited: {} };
    expect(withRunEditing(listed, ran).editing).toEqual(ran);
  });

  it("starts a fresh dialog on reset", () => {
    const reset = withDefaultInputs(
      withTouched({ ...DEFAULT_FEATURESCRIPT_SETTINGS, editing: logicState }, "depth"),
    );
    expect([reset.editing, reset.touched]).toEqual([undefined, undefined]);
  });
});

/**
 * Keeping a manipulator drag's result as the person's inputs. The run that took the drag ran the
 * change function and then the feature with the inputs it set, returned as expressions. Ways this
 * goes wrong: an input the change set isn't kept, so the next run puts the model back; a list
 * edited item by item becomes one expression, so its items can't be edited or reordered any more;
 * the run's items are matched to the list's by position, not key; an item's inputs the change
 * didn't touch are rewritten, or lose their picks; a failed change (no inputs back) changes
 * anything; the run's dialog state isn't kept, or the inputs it took stay marked, so the next run
 * takes them again; the settings don't change their edit count, so the panel can't tell its own
 * update from the person's next edit.
 */
describe("withManipulated", () => {
  const item = (z: string, extra: Partial<FeatureScriptDialogItemInput> = {}) => [
    field("point", "1 point", { kind: "query" }),
    field("x", "0 mm"),
    field("z", z),
    ...(extra.id ? [field(extra.id, extra.value ?? "", extra)] : []),
  ];
  function field(
    id: string,
    value: string,
    extra: Partial<FeatureScriptDialogItemInput> = {},
  ): FeatureScriptDialogItemInput {
    return {
      id,
      label: id,
      kind: "length",
      value,
      options: [],
      visible: true,
      faulty: false,
      group: null,
      filter: null,
      maxPicks: null,
      ...extra,
    };
  }
  const list = (items: FeatureScriptDialogItemInput[][]): FeatureScriptDialogInput => ({
    ...field("waypoints", "", { kind: "array" }),
    itemName: "Waypoint",
    items,
  });
  const lead = (value: string): FeatureScriptDialogInput => ({
    ...field("lead", value),
    itemName: null,
    items: [],
  });
  const picked = 'qCreatedBy(makeId("Picked") + "p1", EntityType.BODY)';
  const waypoints = [
    { key: "a", parameters: { point: picked }, picks: { point: [[0, 0, 0]] as const } },
    { key: "b", parameters: { z: "5 * millimeter" }, picks: {} },
  ];
  const settings: FeatureScriptFileSettings = {
    ...DEFAULT_FEATURESCRIPT_SETTINGS,
    parameters: { lead: "15 * millimeter" },
    lists: { waypoints },
    touched: ["lead"],
    edits: 3,
  };
  const from = {
    inputs: [lead("15 mm"), list([item("0 mm"), item("5 mm")])],
    listKeys: { waypoints: ["a", "b"] },
  };
  // Waypoint b dragged to z = 40.5 mm; the change function wrote the whole list back.
  const ran = {
    inputs: [lead("15 mm"), list([item("0 mm"), item("40.5 mm")])],
    listKeys: { waypoints: ["a", "b"] },
    parameters: {
      lead: "15 * millimeter",
      waypoints: `[{ "point" : ${picked}, "x" : 0 * meter, "z" : 0 * meter }, { "x" : 0 * meter, "z" : 0.0405 * meter }]`,
    },
    editing: { parameters: {}, edited: { lead: "0.015 * meter" } },
  };

  it("sets the dragged item's changed inputs and leaves the rest as they were", () => {
    const kept = withManipulated(settings, from, ran);
    expect(kept.lists?.waypoints).toEqual([
      waypoints[0],
      { key: "b", parameters: { z: "40.5 * millimeter" }, picks: {}, points: {}, queries: {} },
    ]);
    expect(kept.parameters).toEqual(settings.parameters);
  });

  it("matches the run's items by key", () => {
    const moved = {
      ...settings,
      lists: { waypoints: waypoints.toReversed() },
    };
    const kept = withManipulated(moved, from, ran);
    expect(kept.lists?.waypoints?.map((entry) => [entry.key, entry.parameters.z])).toEqual([
      ["b", "40.5 * millimeter"],
      ["a", undefined],
    ]);
  });

  it("keeps a top-level input the change set, and a list set as one expression, exactly", () => {
    const longer = {
      ...ran,
      inputs: [lead("20 mm"), ran.inputs[1]!],
      parameters: { ...ran.parameters, lead: "0.02 * meter" },
    };
    const asExpression = { ...settings, lists: {} };
    const kept = withManipulated(asExpression, from, longer);
    expect(kept.parameters).toEqual({
      lead: "0.02 * meter",
      waypoints: longer.parameters.waypoints,
    });
  });

  it("falls back to the run's expression for a changed item input it can't write", () => {
    const named = {
      ...ran,
      inputs: [
        lead("15 mm"),
        list([item("0 mm"), item("5 mm", { id: "tag", value: "x", kind: "other" })]),
      ],
    };
    const before = {
      ...from,
      inputs: [
        lead("15 mm"),
        list([item("0 mm"), item("5 mm", { id: "tag", value: "y", kind: "other" })]),
      ],
    };
    const kept = withManipulated(settings, before, named);
    expect(kept.lists?.waypoints).toBeUndefined();
    expect(kept.parameters.waypoints).toBe(ran.parameters.waypoints);
  });

  it("keeps the run's dialog state for the inputs it now sends, and counts the edit", () => {
    const kept = withManipulated(settings, from, ran);
    expect(kept.touched).toBeUndefined();
    expect(kept.edits).toBe(4);
    expect(kept.editing).toEqual({
      parameters: previewInputs(kept).parameters,
      edited: ran.editing.edited,
    });
    // So storing that run's state again changes nothing.
    expect(withRunEditing(kept, ran.editing)).toBe(kept);
    expect(withManipulated(settings, from, { ...ran, editing: null }).editing).toBeUndefined();
  });

  it("changes nothing for a change that failed", () => {
    expect(withManipulated(settings, from, { ...ran, parameters: null })).toBe(settings);
  });
});
