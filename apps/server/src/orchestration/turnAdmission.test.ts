import { MessageId, TurnId } from "@cadsense/contracts";
import { expect, it } from "vite-plus/test";
import {
  completeTurnAdmission,
  requestTurnAdmission,
  settleTurnAdmission,
} from "./turnAdmission.ts";

const a = MessageId.make("a");
const b = MessageId.make("b");
const turn = TurnId.make("native-a");
const now = "2026-09-05T00:00:00.000Z";

it("holds accepted requests through native completion", () => {
  const requested = requestTurnAdmission(undefined, a, now);
  const accepted = settleTurnAdmission(requested, a, turn);
  expect(accepted.pending).toEqual([{ messageId: a, requestedAt: now, turnId: turn }]);
  expect(completeTurnAdmission(accepted, turn)).toEqual({ pending: [], completedTurnIds: [] });
});

it("settles completion-before-response without releasing another request", () => {
  const requested = requestTurnAdmission(requestTurnAdmission(undefined, a, now), b, now);
  const completed = completeTurnAdmission(requested, turn);
  expect(completed.pending).toHaveLength(2);
  const accepted = settleTurnAdmission(completed, a, turn);
  expect(accepted.pending.map((entry) => entry.messageId)).toEqual([b]);
  expect(settleTurnAdmission(accepted, b, null)).toEqual({ pending: [], completedTurnIds: [] });
});

it("a stale failed request cannot settle a newer pending request", () => {
  const requested = requestTurnAdmission(undefined, b, now);
  expect(settleTurnAdmission(requested, a, null)).toEqual(requested);
  expect(requestTurnAdmission(requested, b, now)).toBe(requested);
});

it("bounds native completion receipts while a start response is pending", () => {
  let state = requestTurnAdmission(undefined, a, now);
  for (let i = 0; i < 1100; i++) state = completeTurnAdmission(state, TurnId.make(`native-${i}`));
  expect(state.completedTurnIds).toHaveLength(1000);
  expect(state.pending).toHaveLength(1);
});
