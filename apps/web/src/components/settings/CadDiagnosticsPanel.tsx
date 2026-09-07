import { useSyncExternalStore } from "react";
import { BoxIcon } from "lucide-react";
import { cadDiagnostics } from "../../cad/CadDiagnostics";
import { SettingsSection } from "./settingsLayout";

const duration = (value: number | null) =>
  value === null ? "No samples" : `${value.toFixed(1)} ms`;

export function CadDiagnosticsPanel() {
  const state = useSyncExternalStore(
    cadDiagnostics.subscribe,
    cadDiagnostics.getSnapshot,
    cadDiagnostics.getSnapshot,
  );
  const metrics = [
    ["Renderer slots", String(state.renderers)],
    ["Render submission p95", duration(state.frameP95)],
    ["Warm capture p95", duration(state.warmCaptureP95)],
    ["Cold capture p95", duration(state.coldCaptureP95)],
    ["Context losses", String(state.contextLosses)],
    ["Renderer fallbacks", String(state.fallbacks)],
    ["Run circuits opened", String(state.circuits)],
  ];
  return (
    <SettingsSection
      title="CAD diagnostics"
      icon={<BoxIcon className="size-4 text-muted-foreground" />}
    >
      <div className="rounded-2xl border border-border/70 bg-card p-4 sm:p-5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          This client session, across connected environments. Timings use the latest 128 samples per
          category. Render submission measures CPU time, not GPU completion. Capture timings exclude
          queueing and server transport.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {metrics.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-mono text-sm tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Resident snapshots ({state.snapshotIds.length})
          </summary>
          {state.snapshotIds.length ? (
            <ul className="mt-2 space-y-1 font-mono">
              {state.snapshotIds.map((id) => (
                <li className="break-all" key={id}>
                  {id}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-muted-foreground">No CAD snapshots are resident.</p>
          )}
        </details>
      </div>
    </SettingsSection>
  );
}
