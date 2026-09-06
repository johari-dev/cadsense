import { expect, it } from "vite-plus/test";
import { isCadMemoryConstrained } from "./CadMemoryPolicy";

it("serializes low-memory devices or elevated heap pressure without requiring experimental signals", () => {
  expect(isCadMemoryConstrained(4, undefined)).toBe(true);
  expect(isCadMemoryConstrained(2, undefined)).toBe(true);
  expect(isCadMemoryConstrained(8, { usedJSHeapSize: 750, jsHeapSizeLimit: 1000 })).toBe(true);
  expect(isCadMemoryConstrained(8, { usedJSHeapSize: 749, jsHeapSizeLimit: 1000 })).toBe(false);
  expect(isCadMemoryConstrained(undefined, undefined)).toBe(false);
  expect(isCadMemoryConstrained(0, { usedJSHeapSize: 0, jsHeapSizeLimit: 0 })).toBe(false);
  expect(isCadMemoryConstrained(NaN, { usedJSHeapSize: Infinity, jsHeapSizeLimit: 1000 })).toBe(
    false,
  );
});
