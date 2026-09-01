import { scopeThreadRef } from "@cadsense/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@cadsense/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore", () => {
  it("opens the empty panel so the first surface can be selected", () => {
    useRightPanelStore.getState().toggleVisibility(threadRef);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closes an open empty panel", () => {
    useRightPanelStore.getState().toggleVisibility(threadRef);
    useRightPanelStore.getState().toggleVisibility(threadRef);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
    ).toBe(false);
  });
});
