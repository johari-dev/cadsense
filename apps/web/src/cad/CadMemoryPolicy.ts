import * as Schema from "effect/Schema";

const positive = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
const isDeviceMemory = Schema.is(positive);
const isHeap = Schema.is(
  Schema.Struct({
    usedJSHeapSize: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    jsHeapSizeLimit: positive,
  }),
);

/** Conservative Chromium signals, sampled only on lifecycle/capture events, never on an idle timer. */
export function isCadMemoryConstrained(deviceMemory: unknown, heap: unknown) {
  return (
    (isDeviceMemory(deviceMemory) && deviceMemory <= 4) ||
    (isHeap(heap) && heap.usedJSHeapSize >= heap.jsHeapSizeLimit * 0.75)
  );
}
