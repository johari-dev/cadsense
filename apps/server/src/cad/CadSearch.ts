import {
  CadSearchInput,
  CadViewError,
  type CadSearchResult,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { indexCadSnapshot } from "./CadViewState.ts";
const decodeInput = Schema.decodeUnknownEffect(CadSearchInput);

/** Search the selected immutable model, including hidden and suppressed components. */
export const searchCadSnapshot = Effect.fn("searchCadSnapshot")(function* (
  snapshot: CadSnapshotManifest,
  state: CadViewState,
  rawInput: unknown,
): Effect.fn.Return<Omit<CadSearchResult, "inspections">, CadViewError> {
  const input = yield* decodeInput(rawInput).pipe(
    Effect.mapError(() => new CadViewError({ reason: "invalid-operation" })),
  );
  const terms = input.query
    .toLowerCase()
    .split(/[\s/]+/)
    .filter(Boolean);
  if (terms.length === 0) return yield* new CadViewError({ reason: "invalid-operation" });
  const index = indexCadSnapshot(snapshot);
  const visible = index.visible(state);
  const entries: CadSearchResult["entries"][number][] = [];
  let totalMatches = 0;
  // Iterative traversal avoids recursive stacks and repeats no ancestor path construction.
  const pending = (index.children.get(null) ?? []).map((id) => ({ id, path: [] as string[] }));
  while (pending.length > 0) {
    const item = pending.pop()!;
    const node = index.nodes.get(item.id)!;
    const path = [...item.path, node.name];
    const text = path.join("/").toLowerCase();
    if (terms.every((term) => text.includes(term))) {
      totalMatches++;
      if (entries.length < (input.limit ?? 20))
        entries.push({
          occurrenceId: node.id,
          parentOccurrenceId: node.parentId,
          name: node.name,
          kind: node.kind,
          hasChildren: (index.children.get(node.id)?.length ?? 0) > 0,
          visible: visible.get(node.id) ?? false,
          suppressed: node.suppressed,
          path,
        });
    }
    const children = index.children.get(node.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push({ id: children[i]!, path });
  }
  return { revision: state.revision, snapshotId: snapshot.snapshotId, totalMatches, entries };
});
