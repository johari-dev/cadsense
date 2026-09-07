import {
  CadViewError,
  CadHierarchyInput,
  type CadHierarchyResult,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { indexCadSnapshot } from "./CadViewState.ts";

const decodeInput = Schema.decodeUnknownEffect(CadHierarchyInput);
const invalid = () => new CadViewError({ reason: "invalid-operation" });

/** Cursors are bound to an immutable snapshot and parent, not browser focus or mutable list offsets. */
export const readCadHierarchy = Effect.fn("readCadHierarchy")(function* (
  index: ReturnType<typeof indexCadSnapshot>,
  state: CadViewState,
  rawInput: unknown,
): Effect.fn.Return<CadHierarchyResult, CadViewError> {
  const input = yield* decodeInput(rawInput).pipe(Effect.mapError(invalid));
  const parent = input.parentOccurrenceId ?? null;
  if (parent !== null && !index.nodes.has(parent)) return yield* invalid();
  const prefix = `${state.snapshotId}:${parent ?? "root"}:`;
  const suffix = input.cursor?.slice(prefix.length);
  if (
    input.cursor !== undefined &&
    (!input.cursor.startsWith(prefix) || !suffix || !/^(0|[1-9][0-9]*)$/.test(suffix))
  )
    return yield* invalid();
  const offset = suffix === undefined ? 0 : Number(suffix);
  const children = index.children.get(parent) ?? [];
  if (!Number.isSafeInteger(offset) || offset > children.length) return yield* invalid();
  const end = Math.min(offset + (input.limit ?? 100), children.length);
  const visibility = index.visible(state);
  return {
    revision: state.revision,
    snapshotId: state.snapshotId,
    entries: children.slice(offset, end).map((occurrenceId) => {
      const node = index.nodes.get(occurrenceId)!;
      return {
        occurrenceId,
        parentOccurrenceId: node.parentId,
        name: node.name,
        kind: node.kind,
        hasChildren: (index.children.get(occurrenceId)?.length ?? 0) > 0,
        visible: visibility.get(occurrenceId) ?? false,
        suppressed: node.suppressed,
      };
    }),
    nextCursor: end < children.length ? `${prefix}${end}` : null,
  };
});
