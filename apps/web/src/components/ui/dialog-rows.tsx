import type { ComponentProps, ReactNode } from "react";

import { WarningIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

/**
 * Label and value rows in a dialog, in the grouped-card style settings pages use. Removal
 * dialogs list what they keep and delete with one `DialogRow` each.
 */
export function DialogRows({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("divide-y divide-border overflow-hidden rounded-lg border", className)}
      {...props}
    />
  );
}

/**
 * One row. `children` sit on the right: a `DialogRowStatus`, a switch, or nothing. A row that
 * holds a control renders as a `label` so clicking its text toggles the control.
 */
export function DialogRow({
  label,
  detail,
  children,
  asLabel = false,
}: {
  label: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  asLabel?: boolean;
}) {
  const Row = asLabel ? "label" : "div";
  return (
    <Row className="flex min-h-10 items-center gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {children}
    </Row>
  );
}

/** A small pill naming what happens to a row's item. `destructive` marks a deletion. */
export function DialogRowStatus({
  tone,
  children,
}: {
  tone: "neutral" | "destructive";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium",
        tone === "destructive"
          ? "bg-error-surface text-error-foreground"
          : "bg-accent text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** A side effect worth stopping for, such as running chats an update restart will stop. */
export function DialogWarning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
      <WarningIcon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A path or URL for the thing a dialog changes, under the title. Long paths wrap. */
export function DialogLocation({ children }: { children: string }) {
  return <p className="font-mono text-xs break-all text-muted-foreground">{children}</p>;
}
