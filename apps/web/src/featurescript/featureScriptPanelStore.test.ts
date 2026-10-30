import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FEATURESCRIPT_SETTINGS,
  withDefaultInputs,
  withRunEditing,
  withTouched,
  withValue,
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
