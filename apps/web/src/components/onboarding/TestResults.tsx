/**
 * The October 24 model sweep from the "Introducing Cadsense" post
 * (apps/marketing/src/components/blog/Scoreboard.astro): one disc transfer
 * with 8 known problems, 3 runs per model, graded blind. Every model below
 * found all 8 known problems in every run; `perReview` is the mean of known
 * plus credible extra problems per run. Update both places together.
 */
const RESULTS = [
  { plan: "ChatGPT Free", model: "GPT 6 Luna", perReview: 8.0 },
  { plan: "ChatGPT Plus or Pro", model: "GPT 6.1 Sol", perReview: 11.7 },
  { plan: "Claude Pro or Max", model: "Opus 5.5", perReview: 12.0 },
] as const;

const SCALE_MAX = Math.max(...RESULTS.map((result) => result.perReview));

/** R1: the evidence behind onboarding's one-line comparison. */
export function TestResults({ onBack }: { readonly onBack: () => void }) {
  return (
    <div>
      <button
        type="button"
        className="text-muted-foreground text-xs underline decoration-foreground/30 underline-offset-2 hover:text-foreground"
        onClick={onBack}
      >
        Back
      </button>
      <h1 className="mt-2 font-semibold text-[22px] tracking-tight">Test results</h1>
      <p className="mt-2 text-muted-foreground text-sm">
        We reviewed one test robot, a disc transfer with 8 known problems, 3 times with each model.
        A grader who didn't know which model wrote each review checked every comment.
      </p>
      <figure className="mt-5 rounded-lg border border-border bg-card px-4 py-4">
        <figcaption className="font-medium text-xs">Average problems found per review</figcaption>
        <div className="mt-3.5 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-3 text-xs">
          {RESULTS.map((result) => (
            <div key={result.plan} className="contents">
              <span>
                {result.plan} <span className="text-tertiary-foreground">· {result.model}</span>
              </span>
              <div className="h-1.5 rounded-full bg-accent" aria-hidden>
                <div
                  className="h-full rounded-full bg-foreground/60"
                  style={{ width: `${(result.perReview / SCALE_MAX) * 100}%` }}
                />
              </div>
              <span className="text-right font-mono tabular-nums">
                {result.perReview.toFixed(1)}
              </span>
            </div>
          ))}
        </div>
      </figure>
      <ul className="mt-4 list-disc space-y-1.5 pl-4 text-muted-foreground text-sm">
        <li>All three found all 8 known problems in every run.</li>
        <li>
          Paid models also found about 4 real problems we hadn't listed, like roller spacers
          pressing into their bearings.
        </li>
        <li>ChatGPT Plus and Claude were close. Claude's comments were the clearest.</li>
      </ul>
      <p className="mt-4 text-tertiary-foreground text-xs">
        One robot is a small test. Your results will vary. Start free now. Your robot stays
        connected if you add Claude later, which takes its own sign-in.
      </p>
    </div>
  );
}
