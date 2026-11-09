import type { ConfirmDialogRequest } from "@cadsense/contracts";

/**
 * The confirmation before removing a folder project. Removal deletes the project's threads,
 * so a non-zero `threadCount` shows as a deleted row. Files on disk are never touched.
 * CAD projects use `CadRemovalDialog` instead, because their removal keeps threads.
 */
export function projectRemovalConfirmation(project: {
  readonly title: string;
  readonly location: string;
  readonly environmentLabel?: string | null | undefined;
  readonly threadCount: number;
}): ConfirmDialogRequest {
  return {
    title: `Remove ${project.title}`,
    location: project.location,
    ...(project.environmentLabel ? { description: `On ${project.environmentLabel}.` } : {}),
    rows: [
      ...(project.threadCount > 0
        ? [
            {
              label: project.threadCount === 1 ? "1 thread" : `${project.threadCount} threads`,
              detail: "History can't be recovered",
              status: { label: "Deleted", tone: "destructive" as const },
            },
          ]
        : []),
      { label: "Files on disk", status: { label: "Kept", tone: "neutral" as const } },
    ],
    confirmLabel: "Remove project",
    variant: "destructive",
  };
}

/** The confirmation before deleting threads: one by its title, or several by count. */
export function threadDeleteConfirmation(
  threads: { readonly title: string } | { readonly count: number },
): ConfirmDialogRequest {
  const single = "title" in threads || threads.count === 1;
  return {
    title:
      "title" in threads
        ? `Delete "${threads.title}"?`
        : `Delete ${threads.count} thread${single ? "" : "s"}?`,
    description: single ? "Its history can't be recovered." : "Their history can't be recovered.",
    confirmLabel: single ? "Delete thread" : "Delete threads",
    variant: "destructive",
  };
}
