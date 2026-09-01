import type { ContextMenuItem } from "@cadsense/contracts";

export type ThreadActionMenuId =
  | "rename"
  | "regenerate-title"
  | "copy"
  | "copy-path"
  | "copy-thread-id"
  | "pin"
  | "unpin"
  | "archive"
  | "delete";

export interface ThreadActionMenuState {
  readonly isRegeneratingTitle: boolean;
  readonly isRunning: boolean;
  readonly isPinned: boolean;
  readonly supportsPinning: boolean;
  readonly supportsTitleRegeneration: boolean;
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    { id: "rename", label: "Rename thread", icon: "pencil" },
    ...(state.supportsTitleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(state.supportsPinning
      ? [
          state.isPinned
            ? ({ id: "unpin", label: "Unpin thread", icon: "pin-off" } as const)
            : ({ id: "pin", label: "Pin thread", icon: "pin" } as const),
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    { id: "delete", label: "Delete", destructive: true, icon: "trash" },
  ];
}
