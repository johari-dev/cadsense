import { scopeThreadRef, scopedThreadKey } from "@cadsense/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@cadsense/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useCadFloatingStore } from "./cadFloatingStore";

const first = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("first"));
const second = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("second"));
const state = () => useCadFloatingStore.getState();
beforeEach(() => useCadFloatingStore.setState({ byThread: {} }));

describe("CAD automatic floating preview", () => {
  it("opens for CAD activity only in the corresponding thread", () => {
    state().observe(first, "turn-1", false);
    expect(state().byThread[scopedThreadKey(first)]?.visible).toBe(true);
    expect(state().byThread[scopedThreadKey(second)]).toBeUndefined();
  });
  it("keeps a dismissed preview closed across further CAD work in that run", () => {
    state().observe(first, "turn-1", false);
    state().dismiss(first, "turn-1");
    state().observe(first, "turn-1", false);
    expect(state().byThread[scopedThreadKey(first)]?.visible).toBe(false);
    state().observe(first, "turn-2", false);
    expect(state().byThread[scopedThreadKey(first)]?.visible).toBe(true);
  });
  it("does not pop out CAD after the user viewed then closed its sidebar", () => {
    state().observe(first, "turn-1", true);
    state().observe(first, "turn-1", false);
    expect(state().byThread[scopedThreadKey(first)]?.visible).toBe(false);
  });
  it("closes floating CAD when it is moved into the panel", () => {
    state().observe(first, "turn-1", false);
    state().observe(first, "turn-1", true);
    expect(state().byThread[scopedThreadKey(first)]?.visible).toBe(false);
  });
  it("retains other thread previews and avoids updates for unchanged activity", () => {
    state().observe(first, "turn-1", false);
    state().observe(second, "turn-2", false);
    const before = state();
    state().observe(first, "turn-1", false);
    expect(state()).toBe(before);
    state().dismiss(second, "turn-2");
    expect(state().byThread[scopedThreadKey(first)]?.visible).toBe(true);
  });
});
