import { useEffect, type ReactNode } from "react";

export function OnshapeFieldError({
  id,
  inputId,
  focusRequest,
  children,
}: {
  readonly id: string;
  readonly inputId: string;
  readonly focusRequest: number | null;
  readonly children: ReactNode;
}) {
  useEffect(() => {
    if (focusRequest !== null) document.getElementById(inputId)?.focus();
  }, [focusRequest, inputId]);

  return (
    <p
      id={id}
      className="text-xs text-destructive-foreground"
      role={focusRequest === null ? undefined : "alert"}
    >
      {children}
    </p>
  );
}
