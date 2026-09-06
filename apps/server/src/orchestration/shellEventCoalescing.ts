import type { OrchestrationEvent } from "@cadsense/contracts";

/** CAD presentation invalidates project state independently of the owning thread's shell. */
export function coalesceShellDomainEvents<
  T extends Pick<OrchestrationEvent, "type" | "aggregateKind" | "aggregateId" | "sequence">,
>(events: readonly T[]): readonly T[] {
  const latest = new Map<string, T>();
  for (const event of events) {
    if (
      event.type === "thread.cad-context-ensured" ||
      event.type === "thread.cad-view-set" ||
      event.type === "thread.cad-user-view-set"
    )
      continue;
    const presentation =
      event.type === "thread.cad-capture-recorded" ||
      event.type === "thread.cad-presentation-settled";
    latest.set(
      `${event.aggregateKind}:${event.aggregateId}${presentation ? ":cad-project" : ""}`,
      event,
    );
  }
  return [...latest.values()].sort((a, b) => a.sequence - b.sequence);
}
