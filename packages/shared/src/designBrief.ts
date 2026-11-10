/**
 * Shared rules for a project's design brief (DESIGN.md). The server reader and the web entry
 * points both use them, so what the UI calls "filled in" is exactly what reaches agents.
 * See apps/server/src/cad/CadDesignBriefSpec.md.
 */

/** Whether the brief file exists and holds anything beyond the template's comment. */
export type DesignBriefState = "missing" | "template" | "filled";

/** Removes `<!-- ... -->` comments, where the template keeps its questions, and trims. */
export function stripDesignBriefComments(text: string): string {
  return text.replaceAll(/<!--[\s\S]*?-->/g, "").trim();
}

/** Classifies a brief from its contents, or `null` when the file does not exist. */
export function designBriefState(contents: string | null): DesignBriefState {
  if (contents === null) return "missing";
  return stripDesignBriefComments(contents).length > 0 ? "filled" : "template";
}
