/**
 * Whether a workspace file is FeatureScript: a `.fs` file whose first statement, after whitespace
 * and comments, is a `FeatureScript <version>;` header. F# and GLSL shaders use `.fs` too. One pass
 * over the comments, so a long banner can't stall the panel.
 */
export function isFeatureScriptFile(path: string, contents: string): boolean {
  if (!/\.fs$/i.test(path)) return false;
  let at = 0;
  while (at < contents.length) {
    if (/\s/.test(contents[at]!)) at += 1;
    else if (contents.startsWith("//", at)) {
      const end = contents.indexOf("\n", at);
      if (end < 0) return false;
      at = end + 1;
    } else if (contents.startsWith("/*", at)) {
      const end = contents.indexOf("*/", at + 2);
      if (end < 0) return false;
      at = end + 2;
    } else break;
  }
  return /^FeatureScript\s+\d+\s*;/.test(contents.slice(at, at + 64));
}
