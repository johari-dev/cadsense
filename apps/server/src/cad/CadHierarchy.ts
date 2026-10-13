import {
  CadViewError,
  CadHierarchyEntry,
  CadHierarchyInput,
  CadHierarchyResult,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CAD_TOOL_PAGE_BYTES, decodeCadToolInput, indexCadSnapshot } from "./CadViewState.ts";

const invalid = () => new CadViewError({ reason: "invalid-operation" });
const encodeEntryJson = Schema.encodeSync(Schema.fromJsonString(CadHierarchyEntry));
const encodeResultJson = Schema.encodeSync(Schema.fromJsonString(CadHierarchyResult));
const bytes = (json: string) => new TextEncoder().encode(json).byteLength;

/**
 * Cursors are bound to an immutable snapshot and parent, not browser focus or mutable list offsets.
 * A page holds at most `limit` entries and fewer when more would pass CAD_TOOL_PAGE_BYTES.
 */
export const readCadHierarchy = Effect.fn("readCadHierarchy")(function* (
  index: ReturnType<typeof indexCadSnapshot>,
  state: CadViewState,
  rawInput: unknown,
): Effect.fn.Return<CadHierarchyResult, CadViewError> {
  const input = yield* decodeCadToolInput(CadHierarchyInput, rawInput);
  const parent = input.parentOccurrenceId ?? null;
  if (parent !== null && !index.nodes.has(parent))
    return yield* new CadViewError({
      reason: "invalid-operation",
      details: "parentOccurrenceId is not in the selected root. Omit it to read the top level.",
    });
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
  const stop = Math.min(offset + (input.limit ?? 100), children.length);
  const visibility = index.visible(state);
  const present = (occurrenceId: string): CadHierarchyEntry => {
    const node = index.nodes.get(occurrenceId)!;
    const metadata = node.sourcePartKey ? index.parts.get(node.sourcePartKey)?.metadata : null;
    const material = metadata?.material?.displayName;
    return {
      occurrenceId,
      name: node.name,
      kind: node.kind,
      hasChildren: (index.children.get(occurrenceId)?.length ?? 0) > 0,
      visible: visibility.get(occurrenceId) ?? false,
      suppressed: node.suppressed,
      ...(material === undefined ? {} : { material }),
      ...(metadata?.massKg === undefined ? {} : { massKg: metadata.massKg }),
    };
  };
  const page = {
    revision: state.revision,
    snapshotId: state.snapshotId,
    parentOccurrenceId: parent,
  };
  // Reserve room for the longest cursor this page could carry, then add entries until the budget runs out.
  let used = bytes(
    encodeResultJson({ ...page, entries: [], nextCursor: `${prefix}${children.length}` }),
  );
  const entries: CadHierarchyEntry[] = [];
  let end = offset;
  while (end < stop) {
    const entry = present(children[end]!);
    const cost = bytes(encodeEntryJson(entry)) + (entries.length > 0 ? 1 : 0);
    if (entries.length > 0 && used + cost > CAD_TOOL_PAGE_BYTES) break;
    entries.push(entry);
    used += cost;
    end++;
  }
  return { ...page, entries, nextCursor: end < children.length ? `${prefix}${end}` : null };
});
