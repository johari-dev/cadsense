import type { MessageId, ThreadTurnAdmission, TurnId } from "@cadsense/contracts";

export const emptyTurnAdmission = (): ThreadTurnAdmission => ({
  pending: [],
  completedTurnIds: [],
});
export function requestTurnAdmission(
  state: ThreadTurnAdmission | undefined,
  messageId: MessageId,
  requestedAt: string,
): ThreadTurnAdmission {
  const current = state ?? emptyTurnAdmission();
  if (current.pending.some((entry) => entry.messageId === messageId)) return current;
  return { ...current, pending: [...current.pending, { messageId, requestedAt, turnId: null }] };
}
export function settleTurnAdmission(
  state: ThreadTurnAdmission | undefined,
  messageId: MessageId,
  turnId: TurnId | null,
): ThreadTurnAdmission {
  const current = state ?? emptyTurnAdmission();
  const pending =
    turnId === null || current.completedTurnIds.includes(turnId)
      ? current.pending.filter((entry) => entry.messageId !== messageId)
      : current.pending.map((entry) =>
          entry.messageId === messageId ? { ...entry, turnId } : entry,
        );
  return { pending, completedTurnIds: pending.length === 0 ? [] : current.completedTurnIds };
}
export function completeTurnAdmission(
  state: ThreadTurnAdmission | undefined,
  turnId: TurnId,
): ThreadTurnAdmission {
  const current = state ?? emptyTurnAdmission();
  const pending = current.pending.filter((entry) => entry.turnId !== turnId);
  return {
    pending,
    completedTurnIds:
      pending.length === 0
        ? []
        : [...current.completedTurnIds.filter((id) => id !== turnId), turnId].slice(-1000),
  };
}
