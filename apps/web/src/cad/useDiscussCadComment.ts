import type { CadComment, ScopedThreadRef } from "@cadsense/contracts";
import { useSeedComposer } from "../hooks/useSeedComposer";

/** Composer text naming a finding the way `cad_comments_list` reports it, so the agent can look it up. */
export function cadCommentDiscussSeed(comment: CadComment): string {
  const location = comment.targets[0]?.label ?? "";
  return `About CAD comment #${comment.number} "${comment.title}" (${location}): `;
}

/** Returns the Discuss action for findings owned by `threadRef`: seeds that chat's composer with a reference to the finding. */
export function useDiscussCadComment(threadRef: ScopedThreadRef) {
  const seed = useSeedComposer(threadRef);
  return (comment: CadComment) => seed(cadCommentDiscussSeed(comment));
}
