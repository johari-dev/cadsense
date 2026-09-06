import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createCadActivityIndicator, CAD_ACTIVITY_GRACE_MS } from "./CadActivityIndicator";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("appears immediately and stays on through short tool gaps", () => {
  const indicator = createCadActivityIndicator();
  indicator.observe("thread", true);
  expect(indicator.visible("thread")).toBe(true);
  indicator.observe("thread", false);
  vi.advanceTimersByTime(500);
  indicator.observe("thread", true);
  vi.advanceTimersByTime(CAD_ACTIVITY_GRACE_MS);
  expect(indicator.visible("thread")).toBe(true);
  indicator.observe("thread", false);
  vi.advanceTimersByTime(CAD_ACTIVITY_GRACE_MS - 1);
  expect(indicator.visible("thread")).toBe(true);
  vi.advanceTimersByTime(1);
  expect(indicator.visible("thread")).toBe(false);
});

it("preserves grace across surface transfers without extending it on repeated inactive updates", () => {
  const indicator = createCadActivityIndicator();
  indicator.observe("thread", true);
  indicator.observe("thread", false);
  vi.advanceTimersByTime(600);
  indicator.observe("thread", false);
  expect(indicator.visible("thread")).toBe(true);
  vi.advanceTimersByTime(600);
  expect(indicator.visible("thread")).toBe(false);
});

it("isolates threads and notifies only when visible state changes", () => {
  const indicator = createCadActivityIndicator();
  const listener = vi.fn();
  const unsubscribe = indicator.subscribe(listener);
  indicator.observe("a", true);
  indicator.observe("a", true);
  expect(indicator.visible("b")).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  indicator.observe("a", false);
  vi.advanceTimersByTime(CAD_ACTIVITY_GRACE_MS);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  indicator.observe("b", true);
  expect(listener).toHaveBeenCalledTimes(2);
  indicator.observe("b", false);
  vi.runAllTimers();
});
