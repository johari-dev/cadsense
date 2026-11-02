import { scopeThreadRef } from "@cadsense/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@cadsense/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resolveRightPanelSection,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const panel = (ref = threadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore", () => {
  it("keeps the picked section independent per thread", () => {
    const other = scopeThreadRef(threadRef.environmentId, ThreadId.make("thread-2"));
    useRightPanelStore.getState().open(threadRef, "cad");
    useRightPanelStore.getState().open(other, "agents");
    expect(panel().section).toBe("cad");
    expect(panel(other).section).toBe("agents");
    useRightPanelStore.getState().close(threadRef);
    expect(panel()).toMatchObject({ isOpen: false, section: "cad" });
  });

  it("opens and closes the panel before any section is picked", () => {
    useRightPanelStore.getState().toggleVisibility(threadRef);
    expect(panel()).toEqual({ isOpen: true, section: null, file: null, browserTabId: null });
    useRightPanelStore.getState().toggleVisibility(threadRef);
    expect(panel().isOpen).toBe(false);
  });

  it("opens files inside Files and re-reveals the same line on every open", () => {
    useRightPanelStore.getState().openFile(threadRef, "src/a.ts", 12);
    useRightPanelStore.getState().openFile(threadRef, "src/a.ts", 12);
    expect(panel()).toMatchObject({
      isOpen: true,
      section: "files",
      file: { relativePath: "src/a.ts", revealLine: 12, revealRequestId: 2 },
    });
    useRightPanelStore.getState().closeFile(threadRef);
    expect(panel()).toMatchObject({ section: "files", file: null });
  });

  it("forgets the browser once its pages are gone", () => {
    useRightPanelStore.getState().openBrowser(threadRef, "tab-1");
    useRightPanelStore.getState().reconcileBrowser(threadRef, ["tab-1", "tab-2"]);
    expect(panel()).toMatchObject({ section: "browser", browserTabId: "tab-1" });
    useRightPanelStore.getState().reconcileBrowser(threadRef, ["tab-2"]);
    expect(panel()).toMatchObject({ section: "browser", browserTabId: null });
    useRightPanelStore.getState().reconcileBrowser(threadRef, []);
    expect(panel()).toMatchObject({ section: null, browserTabId: null });
  });

  it("drops Files once the thread has no workspace", () => {
    useRightPanelStore.getState().openFile(threadRef, "src/a.ts");
    useRightPanelStore.getState().reconcileFiles(threadRef, false);
    expect(panel()).toMatchObject({ section: null, file: null });
  });
});

describe("resolveRightPanelSection", () => {
  const available = { cad: true, files: true, agents: false, browser: false };

  it("shows the picked section while it is available", () => {
    expect(resolveRightPanelSection("files", available)).toBe("files");
  });

  it("falls back to the first available section, CAD first", () => {
    expect(resolveRightPanelSection(null, available)).toBe("cad");
    expect(resolveRightPanelSection("agents", available)).toBe("cad");
    expect(resolveRightPanelSection(null, { ...available, cad: false })).toBe("files");
  });

  it("shows nothing when no section is available", () => {
    expect(
      resolveRightPanelSection("cad", { cad: false, files: false, agents: false, browser: false }),
    ).toBeNull();
  });
});
