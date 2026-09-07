import { Box } from "lucide-react";

/** Composited trails suggest motion blur without animating a blur filter. */
export function LoadingMark({ kind }: { kind: "app" | "cad" }) {
  const icon = (className: string) =>
    kind === "cad" ? (
      <Box className={className} aria-hidden="true" strokeWidth={1.5} />
    ) : (
      <img className={className} src="/app-icon.png" alt="" aria-hidden="true" />
    );
  return (
    <span
      className={`loading-mark loading-mark--${kind}`}
      role="img"
      aria-label={kind === "cad" ? "Loading CAD" : "Loading cadsense"}
    >
      {icon("loading-logo loading-motion-trail loading-motion-trail--far")}
      {icon("loading-logo loading-motion-trail")}
      {icon("loading-logo")}
    </span>
  );
}
