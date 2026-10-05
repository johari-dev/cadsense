import { describe, expect, it } from "vite-plus/test";
import { onshapeUrlProblem } from "./CadMcpReviews.ts";

// Ways cad_open's offline URL check can fail: a valid tab URL rejected, a dropped /e/ tab or a
// short ID left for a network error to hide, or a non-document path accepted.
const tab =
  "https://cad.onshape.com/documents/0e6a45fa6581191bfeed4d0a/m/437281c10d1a49799e4ed01d/e/ed9df6627855dacf7d96be26";

describe("onshapeUrlProblem", () => {
  it("accepts workspace, version, and microversion tab URLs", () => {
    for (const kind of ["w", "v", "m"])
      expect(onshapeUrlProblem(tab.replace("/m/", `/${kind}/`))).toBe(null);
  });

  it("names a dropped tab, which models do when they copy a long URL", () => {
    expect(
      onshapeUrlProblem(
        "https://cad.onshape.com/documents/0e6a45fa6581191bfeed4d0a/m/437281c10d1a49799e4ed01e",
      ),
    ).toContain("not a tab");
  });

  it("names the ID that lost characters", () => {
    expect(onshapeUrlProblem(tab.replace("4ed01d", "4ed01"))).toContain(
      "ID after /m/ has 23 characters",
    );
  });

  it("rejects paths that are not Onshape documents", () => {
    expect(onshapeUrlProblem("https://cad.onshape.com/folders/abc")).not.toBe(null);
    expect(onshapeUrlProblem("not a url")).not.toBe(null);
  });
});
