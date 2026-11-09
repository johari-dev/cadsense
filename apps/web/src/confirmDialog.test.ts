import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./confirmDialog";

/** A request whose title is `title`, so tests can tell queued confirmations apart. */
function confirmation(title: string, variant: "default" | "destructive" = "default") {
  return { title, confirmLabel: "Confirm", variant } as const;
}

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("returns undefined until a themed host is mounted", () => {
    expect(requestConfirmDialog(confirmation("Confirm this action?"))).toBeUndefined();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("resolves a displayed confirmation and waits for its close transition", async () => {
    const unregister = registerConfirmDialogHost();
    const pending = requireConfirmation(
      requestConfirmDialog(confirmation("Delete this thread?", "destructive")),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      request: confirmation("Delete this thread?", "destructive"),
    });

    respondToConfirmDialog(true);
    await expect(pending).resolves.toBe(true);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      request: confirmation("Delete this thread?", "destructive"),
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog(confirmation("Delete the project?")));
    const second = requireConfirmation(
      requestConfirmDialog(confirmation("Delete the saved data too?")),
    );

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      request: confirmation("Delete the project?"),
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      request: confirmation("Delete the saved data too?"),
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const active = requireConfirmation(requestConfirmDialog(confirmation("Delete the thread?")));
    const queued = requireConfirmation(
      requestConfirmDialog(confirmation("Delete the saved data too?")),
    );

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = registerConfirmDialogHost();
    const pending = requireConfirmation(requestConfirmDialog(confirmation("Continue?")));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(pending).resolves.toBe(true);
  });
});
