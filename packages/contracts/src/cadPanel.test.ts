import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CadPanelState } from "./cadPanel.ts";

const decode = Schema.decodeUnknownSync(CadPanelState);
const base = { threadId: "cad-panel-thread", userRevision: null, view: null, captureId: null };

describe("CAD panel activity", () => {
  it("accepts older servers without an activity signal", () => {
    expect(decode(base)).toEqual({ ...base, agentControlling: false, agentActivityTurnId: null });
  });
  it("retains a completed tool's turn for late subscribers", () => {
    expect(
      decode({ ...base, agentControlling: false, agentActivityTurnId: "cad-tool-turn" })
        .agentActivityTurnId,
    ).toBe("cad-tool-turn");
  });
});
