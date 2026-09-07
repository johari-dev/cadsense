import { ThreadId, type OrchestrationEvent } from "@cadsense/contracts";
import { expect, it } from "vite-plus/test";
import { coalesceShellDomainEvents } from "./shellEventCoalescing.ts";

const event = (type: OrchestrationEvent["type"], sequence: number) => ({
  type,
  sequence,
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread"),
});

it("keeps the project presentation invalidation when a thread completion follows in the same batch", () => {
  const settled = event("thread.cad-presentation-settled", 3);
  const session = event("thread.session-set", 4);
  expect(
    coalesceShellDomainEvents([
      event("thread.cad-capture-recorded", 1),
      event("thread.session-set", 2),
      settled,
      session,
    ]),
  ).toEqual([settled, session]);
});

it("does not let private CAD state hide a preceding thread shell update", () => {
  const session = event("thread.session-set", 1);
  expect(
    coalesceShellDomainEvents([
      session,
      event("thread.cad-view-set", 2),
      event("thread.cad-user-view-set", 3),
      event("thread.cad-context-ensured", 4),
    ]),
  ).toEqual([session]);
});

it("coalesces repeated captures while preserving sequence ordering across threads", () => {
  const capture = event("thread.cad-capture-recorded", 4);
  const other = { ...event("thread.session-set", 3), aggregateId: ThreadId.make("other") };
  expect(
    coalesceShellDomainEvents([
      event("thread.cad-capture-recorded", 1),
      event("thread.cad-capture-recorded", 2),
      other,
      capture,
    ]),
  ).toEqual([other, capture]);
});
