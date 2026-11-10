import { CADSENSE_DESIGN_BRIEF_TEMPLATE } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";

import { designBriefState, stripDesignBriefComments } from "./designBrief.ts";

// Ways this can fail: a missing file, the untouched template, or the template plus blank lines
// reads as filled; a filled template or a brief written without the template reads as unfilled;
// text between two comments is dropped. The server reader calls stripDesignBriefComments too, so
// the UI's state and what agents receive cannot drift apart.
describe("designBriefState", () => {
  it("reports a missing file", () => {
    expect(designBriefState(null)).toBe("missing");
  });

  it("treats the untouched template as not filled in", () => {
    expect(designBriefState(CADSENSE_DESIGN_BRIEF_TEMPLATE)).toBe("template");
    expect(designBriefState(`${CADSENSE_DESIGN_BRIEF_TEMPLATE}\n\n  \n`)).toBe("template");
  });

  it("treats any answer as filled", () => {
    expect(designBriefState(`${CADSENSE_DESIGN_BRIEF_TEMPLATE}The belt is a stand-in.\n`)).toBe(
      "filled",
    );
    expect(designBriefState("The elevator motor rides on the first stage.")).toBe("filled");
  });
});

describe("stripDesignBriefComments", () => {
  it("keeps text between and after comments and trims the rest", () => {
    expect(stripDesignBriefComments("<!-- a -->\nOne.\n<!-- b -->\nTwo.\n")).toBe("One.\n\nTwo.");
  });
});
