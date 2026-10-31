/**
 * What Cadsense's usage analytics can say. The server is the only sender, so this lives with
 * AnalyticsService rather than in contracts.
 *
 * Call sites never build events. They increment a {@link DailyCounter} with
 * `AnalyticsService.count`, and the service turns counters into the few events below. This keeps
 * volume flat however heavily someone uses the app (about two events per active installation per
 * day), and a call site can't send a typo, a path, or a prompt: counters are closed literals.
 *
 * Adding a metric means adding a counter here and calling `count` where the action happens.
 *
 * @module AnalyticsEvents
 */
import * as Schema from "effect/Schema";

/** Every number in `usage.daily`, one per thing worth counting. */
export const DAILY_COUNTERS = [
  "projects_created",
  "threads_started",
  // Turns sent to a provider, by provider family.
  "agent_turns_codex",
  "agent_turns_claude",
  "agent_turns_other",
  "agent_turns_interrupted",
  "agent_sessions_started",
  "agent_sessions_recovered",
  // Answers to approval and user-input requests.
  "agent_requests_answered",
  // CAD syncs that finished, by source, and those that failed (cancelled ones aren't counted).
  "cad_imports_onshape",
  "cad_imports_local",
  "cad_imports_failed",
  // CAD review: comments agents published, and the user's verdicts on them.
  "cad_comments_published",
  "cad_comments_resolved",
  "cad_comments_dismissed",
  // FeatureScript preview jobs. Each job counts once under its source (agent or panel), under its
  // outcome, and under one latency bucket; panel jobs may also count as rollback or manipulator.
  "fs_runs_agent",
  "fs_runs_panel",
  "fs_runs_rollback",
  "fs_runs_manipulator",
  "fs_ok",
  "fs_info",
  "fs_warning",
  "fs_error",
  "fs_invalid",
  "fs_stopped",
  // Runs that failed because the local runtime can't run something the script calls.
  "fs_unsupported",
  // Total job time, including waiting for the preview worker. Buckets, because percentiles from
  // different installs can't be added up and bucket counts can.
  "fs_under_1s",
  "fs_under_5s",
  "fs_under_30s",
  "fs_over_30s",
  "ratings_up",
  "ratings_down",
] as const;
export const DailyCounter = Schema.Literals(DAILY_COUNTERS);
export type DailyCounter = typeof DailyCounter.Type;
export type DailyCounts = Partial<Record<DailyCounter, number>>;

/** The `agent_turns_*` counter for a provider driver, by provider family. */
export const agentTurnCounter = (driver: string): DailyCounter =>
  driver === "codex"
    ? "agent_turns_codex"
    : driver === "claudeAgent"
      ? "agent_turns_claude"
      : "agent_turns_other";

/** Onboarding steps, each sent once per installation. Together they form the onboarding funnel. */
export const Milestone = Schema.Literals([
  "first_launch",
  "first_thread",
  "first_agent_turn",
  "first_cad_import",
  "first_cad_review",
  "first_featurescript_preview",
]);
export type Milestone = typeof Milestone.Type;

/** The milestone a counter's first increment reaches, if any. */
export const MILESTONE_BY_COUNTER: Partial<Record<DailyCounter, Milestone>> = {
  threads_started: "first_thread",
  agent_turns_codex: "first_agent_turn",
  agent_turns_claude: "first_agent_turn",
  agent_turns_other: "first_agent_turn",
  cad_imports_onshape: "first_cad_import",
  cad_imports_local: "first_cad_import",
  cad_comments_published: "first_cad_review",
  fs_runs_agent: "first_featurescript_preview",
  fs_runs_panel: "first_featurescript_preview",
};

/** A UTC calendar day, `YYYY-MM-DD`. */
export const AnalyticsDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The events the service sends:
 * - `app.active`: the first counted action of a UTC day, sent right away, so active-install
 *   charts are current. A server that runs without anyone using it sends nothing.
 * - `usage.daily`: every nonzero counter for a finished day, sent at UTC midnight or on the next
 *   launch.
 * - `milestone.reached`: an onboarding step, once per installation.
 */
export const AnalyticsEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("app.active"),
    properties: Schema.Struct({ day: AnalyticsDay }),
  }),
  Schema.Struct({
    event: Schema.Literal("usage.daily"),
    properties: Schema.Struct({
      day: AnalyticsDay,
      counts: Schema.Record(DailyCounter, Count),
    }),
  }),
  Schema.Struct({
    event: Schema.Literal("milestone.reached"),
    properties: Schema.Struct({ milestone: Milestone }),
  }),
]);
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
