import { describe, expect, it, vi } from "vite-plus/test";
import type { CadViewState } from "@cadsense/contracts";
import { createCadViewEdits } from "./CadViewEdits";

const view: CadViewState = {
  rootId: "a".repeat(64),
  snapshotId: "00000000-0000-4000-8000-000000000001",
  revision: 0,
  camera: { kind: "preset", preset: "front", fit: [] },
  visibility: {},
  isolatedOccurrenceIds: [],
  explosion: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe("CAD view edits", () => {
  it("presents immediately and coalesces rapid selections behind one save", async () => {
    const first = deferred<CadViewState>();
    const second = deferred<CadViewState>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const edits = createCadViewEdits(save, vi.fn());
    edits.observe(0, false);
    edits.select(view);
    edits.select({ ...view, explosion: 0.5 });
    edits.select({ ...view, explosion: 1 });
    expect(edits.getSnapshot()?.explosion).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
    edits.observe(1, false);
    expect(edits.getSnapshot()?.explosion).toBe(1);
    first.resolve({ ...view, revision: 1 });
    await first.promise;
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ explosion: 1, revision: 2 }),
      1,
    );
    second.resolve({ ...view, explosion: 1, revision: 2 });
    await second.promise;
    expect(edits.getSnapshot()?.explosion).toBe(1);
    edits.observe(2, false);
    expect(edits.getSnapshot()).toBeNull();
  });
  it("drops queued edits on an agent lock and rolls back rejected saves", async () => {
    const pending = deferred<CadViewState>();
    const save = vi.fn().mockReturnValue(pending.promise);
    const failed = vi.fn();
    const edits = createCadViewEdits(save, failed);
    edits.observe(4, false);
    edits.select(view);
    edits.select({ ...view, explosion: 1 });
    edits.observe(4, true);
    edits.select(view);
    expect(edits.getSnapshot()).toBeNull();
    pending.reject(new Error("busy"));
    await pending.promise.catch(() => {});
    expect(save).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledOnce();
  });
  it("rolls back all unsaved selections on failure and retries from the observed revision", async () => {
    const pending = deferred<CadViewState>();
    const save = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...view, revision: 5 });
    const failed = vi.fn();
    const edits = createCadViewEdits(save, failed);
    edits.observe(4, false);
    edits.select(view);
    edits.select({ ...view, explosion: 1 });
    pending.reject(new Error("conflict"));
    await pending.promise.catch(() => {});
    expect(edits.getSnapshot()).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    edits.select(view);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 5 }), 4);
    await Promise.resolve();
    edits.observe(5, false);
    expect(edits.getSnapshot()).toBeNull();
  });
});
