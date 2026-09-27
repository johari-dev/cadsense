import type { CadReviewScope, CadReviewScopeMatch, CadSnapshotManifest } from "@cadsense/contracts";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a review scope glob into a case-insensitive RegExp. `*` and `?` stay within one
 * `/` segment, `**` spans segments, and a leading `** /` or trailing `/ **` also matches the
 * bare path so `Drivetrain <1>/**` covers the assembly itself and everything inside it.
 */
export function compileCadReviewGlob(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    if (pattern.startsWith("**/", index) && index === 0) {
      source += "(?:.*/)?";
      index += 2;
    } else if (pattern.startsWith("/**", index) && index === pattern.length - 3) {
      source += "(?:/.*)?";
      index += 2;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else if (pattern[index] === "*") source += "[^/]*";
    else if (pattern[index] === "?") source += "[^/]";
    else source += escapeRegExp(pattern[index]!);
  }
  return new RegExp(`^${source}$`, "i");
}

/** The occurrence facts a scope match is evaluated against. */
export interface CadReviewScopeSubject {
  /** Instance names from the top level down to the occurrence, joined with "/". */
  readonly path: string;
  readonly name: string;
  /** Source part material display name, or null for assemblies and parts without one. */
  readonly material: string | null;
}

/** True when every field listed in `match` matches the subject. */
export function matchesCadReviewScope(
  match: CadReviewScopeMatch,
  subject: CadReviewScopeSubject,
): boolean {
  if (match.path !== undefined && !compileCadReviewGlob(match.path).test(subject.path))
    return false;
  if (match.name !== undefined && !compileCadReviewGlob(match.name).test(subject.name))
    return false;
  if (match.material !== undefined)
    return subject.material !== null && compileCadReviewGlob(match.material).test(subject.material);
  return true;
}

/** Human-readable match summary for review guidance, e.g. `path Drivetrain/**, material *steel*`. */
export function describeCadReviewScopeMatch(match: CadReviewScopeMatch): string {
  return (["path", "name", "material"] as const)
    .flatMap((field) => (match[field] === undefined ? [] : [`${field} ${match[field]}`]))
    .join(", ");
}

/** Every occurrence subject in a snapshot, keyed by occurrence ID. The root node is not a subject. */
export function cadReviewScopeSubjects(
  snapshot: CadSnapshotManifest,
): ReadonlyMap<string, CadReviewScopeSubject> {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const materials = new Map(
    snapshot.parts.map((part) => [part.geometryKey, part.metadata?.material?.displayName ?? null]),
  );
  const paths = new Map<string, string>();
  const pathOf = (id: string): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const node = nodes.get(id)!;
    // The root node stands for the whole model, so top-level instances start the path.
    const parentPath = node.parentId === null ? "" : pathOf(node.parentId);
    const path =
      node.parentId === null ? "" : parentPath ? `${parentPath}/${node.name}` : node.name;
    paths.set(id, path);
    return path;
  };
  const subjects = new Map<string, CadReviewScopeSubject>();
  for (const node of snapshot.nodes) {
    if (node.parentId === null) continue;
    subjects.set(node.id, {
      path: pathOf(node.id),
      name: node.name,
      material: node.sourcePartKey === null ? null : (materials.get(node.sourcePartKey) ?? null),
    });
  }
  return subjects;
}

/**
 * Occurrence IDs excluded from review by `ignore` scopes. A matching assembly excludes its
 * whole subtree, so children inherit the flag.
 */
export function ignoredCadOccurrences(
  scopes: ReadonlyArray<CadReviewScope>,
  snapshot: CadSnapshotManifest,
): ReadonlySet<string> {
  const ignoreScopes = scopes.filter((scope) => scope.ignore === true);
  if (ignoreScopes.length === 0) return new Set();
  const subjects = cadReviewScopeSubjects(snapshot);
  const parents = new Map(snapshot.nodes.map((node) => [node.id, node.parentId]));
  const decided = new Map<string, boolean>();
  const isIgnored = (id: string): boolean => {
    const known = decided.get(id);
    if (known !== undefined) return known;
    const subject = subjects.get(id);
    const parentId = parents.get(id) ?? null;
    const result =
      subject !== undefined &&
      ((parentId !== null && isIgnored(parentId)) ||
        ignoreScopes.some((scope) => matchesCadReviewScope(scope.match, subject)));
    decided.set(id, result);
    return result;
  };
  return new Set(snapshot.nodes.filter((node) => isIgnored(node.id)).map((node) => node.id));
}
