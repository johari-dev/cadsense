import { describe, expect, it } from "vite-plus/test";
import { isFeatureScriptFile } from "./featureScriptFiles";

/**
 * Deciding whether a `.fs` file is FeatureScript. Ways this goes wrong: an F# or GLSL file treated
 * as FeatureScript; a header after comments or a byte-order mark missed; the word FeatureScript in
 * a comment taken for the header; an unterminated comment; and, since this runs while the panel
 * renders, a check whose time grows faster than the file (a long `////` banner froze the tab).
 */
describe("isFeatureScriptFile", () => {
  it("needs the .fs extension and a FeatureScript header", () => {
    expect(isFeatureScriptFile("a/bolt.fs", "FeatureScript 3083;\nimport(...)")).toBe(true);
    expect(isFeatureScriptFile("a/BOLT.FS", "FeatureScript 3083 ;")).toBe(true);
    expect(isFeatureScriptFile("a/bolt.txt", "FeatureScript 3083;")).toBe(false);
    expect(isFeatureScriptFile("Program.fs", "module Program\nlet x = 1\n")).toBe(false);
    expect(isFeatureScriptFile("glow.fs", "#version 330 core\nout vec4 c;\n")).toBe(false);
  });

  it("looks past whitespace, comments and a byte-order mark", () => {
    expect(
      isFeatureScriptFile("b.fs", "﻿// Bolt circle\n/* by the team\n */\n\nFeatureScript 2716;"),
    ).toBe(true);
    expect(isFeatureScriptFile("b.fs", "// FeatureScript 3083;\nlet x = 1")).toBe(false);
    expect(isFeatureScriptFile("b.fs", "/* FeatureScript 3083; */ let x = 1")).toBe(false);
    expect(isFeatureScriptFile("b.fs", "/* never closed FeatureScript 3083;")).toBe(false);
    expect(isFeatureScriptFile("b.fs", "// only a comment")).toBe(false);
  });

  it("takes linear time on long banners and comments", () => {
    const banner = `${"/".repeat(4000)}\n${"// see https://a.b/c // d //\n".repeat(2000)}`;
    const started = performance.now();
    expect(isFeatureScriptFile("glow.fs", `${banner}#version 330\n`)).toBe(false);
    expect(isFeatureScriptFile("bolt.fs", `${banner}FeatureScript 3083;`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
