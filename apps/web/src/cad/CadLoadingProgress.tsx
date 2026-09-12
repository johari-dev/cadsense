export interface CadLoadProgress {
  readonly received: number;
  readonly total: number;
}

export function CadLoadingProgress({ progress = null }: { progress?: CadLoadProgress | null }) {
  const percent = progress
    ? Math.min(100, Math.floor((progress.received / Math.max(1, progress.total)) * 100))
    : 0;
  const complete = progress !== null && progress.received >= progress.total;
  const label = !progress ? "Preparing CAD…" : complete ? "Preparing geometry…" : "Loading CAD";
  return (
    <div className="w-full max-w-56 space-y-2 text-xs text-muted-foreground">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        {progress && <span className="tabular-nums">{percent}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress ? percent : undefined}
        aria-valuetext={complete ? "CAD data loaded; preparing geometry" : undefined}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      {progress && (
        <div className="text-center tabular-nums">
          {complete
            ? "CAD data loaded"
            : `${(progress.received / 1_000_000).toFixed(1)} / ${(progress.total / 1_000_000).toFixed(1)} MB`}
        </div>
      )}
    </div>
  );
}
