import type { CadSnapshotManifest, CadViewState } from "@cadsense/contracts";

/** Shared hierarchy and visibility semantics for server commands and local renderers. */
export const indexCadSnapshot = (snapshot: CadSnapshotManifest) => {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, string[]>();
  for (const node of snapshot.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const subtree = (ids: readonly string[]) => {
    const result = new Set<string>();
    const pending = [...ids];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (result.has(id)) continue;
      result.add(id);
      for (const child of children.get(id) ?? []) pending.push(child);
    }
    return result;
  };
  const visible = (state: CadViewState) => {
    const isolated = subtree(state.isolatedOccurrenceIds);
    for (const occurrenceId of state.isolatedOccurrenceIds) {
      let parentId = nodes.get(occurrenceId)?.parentId;
      while (parentId) {
        isolated.add(parentId);
        parentId = nodes.get(parentId)?.parentId;
      }
    }
    const result = new Map<string, boolean>();
    const pending = [...(children.get(null) ?? [])].map((id) => ({ id, parentVisible: true }));
    while (pending.length > 0) {
      const { id, parentVisible } = pending.pop()!;
      const node = nodes.get(id)!;
      const own =
        parentVisible && !node.suppressed && (state.visibility[id] ?? node.defaultVisible);
      result.set(id, own && (isolated.size === 0 || isolated.has(id)));
      for (const child of children.get(id) ?? []) pending.push({ id: child, parentVisible: own });
    }
    return result;
  };
  return { nodes, children, subtree, visible };
};

/** Reveal selected subtrees through hidden ancestors without changing sibling overrides. */
export function revealCadOccurrences(
  index: ReturnType<typeof indexCadSnapshot>,
  state: CadViewState,
  ids: readonly string[],
) {
  const visibility = { ...state.visibility };
  for (const id of index.subtree(ids)) visibility[id] = true;
  for (const id of ids) {
    let parent = index.nodes.get(id)?.parentId;
    while (parent) {
      visibility[parent] = true;
      parent = index.nodes.get(parent)?.parentId;
    }
  }
  return visibility;
}
