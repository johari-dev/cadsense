// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off
/**
 * End-to-end check of anonymous usage analytics against a fake PostHog ingest. Runs the real
 * server (`src/bin.ts`) several times in one data directory and keeps the evidence under --out:
 *
 *   requests.jsonl    every request the fake ingest received, tagged with the phase that sent it
 *   summary.json      each check with pass/fail and the values it compared
 *   server-<phase>.log  each server run's output
 *
 *   node apps/server/scripts/analytics-e2e.ts --out .cadsense/analytics-e2e/run
 *
 * Phases, in order:
 *   enabled        a key is set, and analytics-state.json is seeded as a run on an earlier day
 *                  left it: that day's counts arrive as one `usage.daily` with every counter as a
 *                  flat property, the event left unsent goes out with its uuid, `first_launch` is
 *                  sent, and all are keyed by the namespaced installation id, never by the Codex
 *                  account id planted in the fake home directory
 *   opt-out-live   the user turns analytics off while the server runs: the id and state files
 *                  are deleted
 *   opted-out      a restart with analytics off sends nothing and creates no files
 *   opted-in       turning it back on sends again, under a new, unlinked id
 *   error-report   a provider instance with a broken config in settings.json makes the server
 *                  log an error: it arrives as one `$exception` with the code's message and no
 *                  local path
 *   error-repeat   a restart that logs the same error the same day sends nothing new
 *   no-key         a build with no PostHog key (dev, forks) sends nothing and creates no files
 *
 * Exits non-zero if any check fails.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("Usage: --out <dir>");
const out = NodePath.resolve(values.out);
if (NodeFS.existsSync(out)) throw new Error(`${out} already exists. Use a fresh --out directory.`);
NodeFS.mkdirSync(out, { recursive: true });

const bin = NodePath.resolve(import.meta.dirname, "../src/bin.ts");
const baseDir = NodePath.join(out, "base");
const userdata = NodePath.join(baseDir, "userdata");
const idPath = NodePath.join(userdata, "anonymous-id");
const settingsPath = NodePath.join(userdata, "settings.json");
const statePath = NodePath.join(userdata, "analytics-state.json");
const SEEDED_DAY = "2000-01-01";
const SEEDED_PENDING_UUID = "0b0e2a1c-5d3f-4c1e-9a6b-7c8d9e0f1a2b";
// A home directory with a Codex login, so the run proves analytics ignore it.
const fakeHome = NodePath.join(out, "home");
const CODEX_ACCOUNT_ID = "e2e-codex-account";
NodeFS.mkdirSync(NodePath.join(fakeHome, ".codex"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(fakeHome, ".codex", "auth.json"),
  JSON.stringify({ tokens: { account_id: CODEX_ACCOUNT_ID } }),
);
const POSTHOG_KEY = "phc_e2e_test_key";

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CapturedEvent {
  readonly event: string;
  readonly uuid: string;
  readonly timestamp: string;
  readonly distinct_id: string;
  readonly properties: Record<string, unknown>;
}
interface CapturedRequest {
  readonly phase: string;
  readonly path: string;
  readonly apiKey: unknown;
  readonly events: ReadonlyArray<CapturedEvent>;
}

let phase = "setup";
const requests: CapturedRequest[] = [];
const ingest = NodeHttp.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
  request.on("end", () => {
    const parsed = JSON.parse(body || "{}") as { api_key?: unknown; batch?: CapturedEvent[] };
    const captured = {
      phase,
      path: request.url ?? "",
      apiKey: parsed.api_key,
      events: parsed.batch ?? [],
    };
    requests.push(captured);
    NodeFS.appendFileSync(NodePath.join(out, "requests.jsonl"), `${JSON.stringify(captured)}\n`);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
const ingestAddress = ingest.address();
if (ingestAddress === null || typeof ingestAddress === "string") throw new Error("no ingest port");
const ingestUrl = `http://127.0.0.1:${ingestAddress.port}`;

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: Record<string, unknown>;
}
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: Record<string, unknown> = {}) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};

const eventsIn = (name: string) =>
  requests.filter((r) => r.phase === name).flatMap((r) => r.events);
const readId = () =>
  NodeFS.existsSync(idPath) ? NodeFS.readFileSync(idPath, "utf8").trim() : null;
const writeSettings = (enableUsageAnalytics: boolean) => {
  const current = NodeFS.existsSync(settingsPath)
    ? (JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  NodeFS.writeFileSync(settingsPath, JSON.stringify({ ...current, enableUsageAnalytics }, null, 2));
};

/** Waits until `ready` holds, polling every 200 ms, up to `timeoutMs`. */
const waitFor = async (ready: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    await sleep(200);
  }
  return ready();
};

/** A port nothing is listening on; the server CLI rejects --port 0. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address !== null && typeof address !== "string" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

/**
 * Starts the server for one phase and returns a stop function. `withKey` decides whether the run
 * looks like a release build (key set) or a dev/fork build (no key).
 */
const startServer = async (name: string, withKey: boolean) => {
  phase = name;
  const log = NodeFS.createWriteStream(NodePath.join(out, `server-${name}.log`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CADSENSE_POSTHOG_HOST: ingestUrl,
    CADSENSE_TELEMETRY_ENABLED: "true",
  };
  if (withKey) env.CADSENSE_POSTHOG_KEY = POSTHOG_KEY;
  else delete env.CADSENSE_POSTHOG_KEY;
  const child = NodeChildProcess.spawn(
    process.execPath,
    [bin, "--port", String(await freePort()), "--base-dir", baseDir],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const capture = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    log.write(chunk);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const listening = await waitFor(() => output.includes("Listening on"), 60_000);
  if (!listening) throw new Error(`server for ${name} never started; see server-${name}.log`);
  return async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(15_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    log.end();
  };
};

// enabled
NodeFS.mkdirSync(userdata, { recursive: true });
NodeFS.writeFileSync(
  statePath,
  JSON.stringify({
    version: 1,
    day: SEEDED_DAY,
    counts: { agent_turns_codex: 3, fs_runs_panel: 2, removed_in_a_later_version: 5 },
    activeSent: true,
    finished: [],
    milestones: [],
    pending: [
      {
        uuid: SEEDED_PENDING_UUID,
        capturedAt: `${SEEDED_DAY}T12:00:00.000Z`,
        payload: { event: "milestone.reached", properties: { milestone: "first_thread" } },
      },
    ],
  }),
);
let stop = await startServer("enabled", true);
const summaryIn = (name: string) => eventsIn(name).find((event) => event.event === "usage.daily");
const launchIn = (name: string) =>
  eventsIn(name).find((event) => event.properties.milestone === "first_launch");
await waitFor(
  () => summaryIn("enabled") !== undefined && launchIn("enabled") !== undefined,
  20_000,
);
const firstId = readId();
const summary = summaryIn("enabled");
const firstLaunch = launchIn("enabled");
check("enabled: the seeded day's counts arrive as one usage.daily", summary !== undefined, {
  summary,
});
check(
  "enabled: usage.daily is stamped on its day and carries every counter as a flat property",
  summary?.properties.day === SEEDED_DAY &&
    summary.properties.agent_turns_codex === 3 &&
    summary.properties.fs_runs_panel === 2 &&
    summary.properties.ratings_up === 0 &&
    summary.timestamp === `${SEEDED_DAY}T23:59:59.999Z` &&
    !("removed_in_a_later_version" in summary.properties) &&
    !("counts" in summary.properties),
);
check(
  "enabled: the event left unsent by the earlier run goes out with its uuid",
  eventsIn("enabled").some(
    (event) => event.uuid === SEEDED_PENDING_UUID && event.properties.milestone === "first_thread",
  ),
);
check("enabled: first_launch is sent", firstLaunch !== undefined);
check(
  "enabled: requests carry the configured key",
  requests.filter((r) => r.phase === "enabled").every((r) => r.apiKey === POSTHOG_KEY),
);
check(
  "enabled: distinct_id is sha256 of the namespaced installation id",
  firstId !== null &&
    eventsIn("enabled").every((event) => event.distinct_id === sha256(`cadsense:v1:${firstId}`)),
  { installationId: firstId, distinctId: firstLaunch?.distinct_id },
);
check(
  "enabled: distinct_id ignores the Codex account id",
  eventsIn("enabled").every(
    (event) =>
      event.distinct_id !== sha256(CODEX_ACCOUNT_ID) &&
      event.distinct_id !== sha256(`cadsense:v1:${CODEX_ACCOUNT_ID}`),
  ),
);
check(
  "enabled: events never create person profiles or look up location",
  eventsIn("enabled").every(
    (event) =>
      event.properties.$process_person_profile === false &&
      event.properties.$geoip_disable === true,
  ),
);
check(
  "enabled: launching alone doesn't mark the day active",
  !eventsIn("enabled").some((event) => event.event === "app.active"),
);
check(
  "enabled: no event is sent twice",
  new Set(eventsIn("enabled").map((event) => event.uuid)).size === eventsIn("enabled").length,
);

// opt-out-live
phase = "opt-out-live";
writeSettings(false);
const idDeleted = await waitFor(() => readId() === null && !NodeFS.existsSync(statePath), 15_000);
check("opt-out-live: turning analytics off deletes the id and state files", idDeleted);
await stop();

// opted-out
stop = await startServer("opted-out", true);
await sleep(5_000);
await stop();
check("opted-out: a restart with analytics off sends nothing", eventsIn("opted-out").length === 0, {
  received: eventsIn("opted-out").map((event) => event.event),
});
check(
  "opted-out: no id or state file is created",
  readId() === null && !NodeFS.existsSync(statePath),
);

// opted-in
writeSettings(true);
stop = await startServer("opted-in", true);
await waitFor(() => launchIn("opted-in") !== undefined, 20_000);
await stop();
const secondId = readId();
const secondLaunch = launchIn("opted-in");
check("opted-in: sending resumes, starting over with first_launch", secondLaunch !== undefined);
check(
  "opted-in: it uses a new installation id",
  secondId !== null &&
    secondId !== firstId &&
    secondLaunch?.distinct_id === sha256(`cadsense:v1:${secondId}`),
  { firstId, secondId },
);

// error-report
const writeBrokenProviderInstance = (broken: boolean) => {
  const current = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  const { providerInstances: _previous, ...rest } = current;
  NodeFS.writeFileSync(
    settingsPath,
    JSON.stringify(
      broken
        ? {
            ...rest,
            providerInstances: {
              codex_e2e_broken: { driver: "codex", config: { binaryPath: 123, enabled: "no" } },
            },
          }
        : rest,
      null,
      2,
    ),
  );
};
const reportsIn = (name: string) => eventsIn(name).filter((event) => event.event === "$exception");
writeBrokenProviderInstance(true);
stop = await startServer("error-report", true);
await waitFor(() => reportsIn("error-report").length > 0, 20_000);
await sleep(3_000);
await stop();
const errorReports = reportsIn("error-report");
const reportValues = errorReports.map(
  (event) =>
    (event.properties.$exception_list as ReadonlyArray<{ type: string; value: string }>)[0],
);
check(
  "error-report: the broken config's error log arrives once as an $exception",
  reportValues.filter((entry) => entry?.value === "Failed to decode provider instance config")
    .length === 1,
  { reportValues },
);
check(
  "error-report: reports carry no local path",
  !JSON.stringify(errorReports).includes(out) && !JSON.stringify(errorReports).includes(fakeHome),
);
check(
  "error-report: reports are keyed by the installation id",
  errorReports.every((event) => event.distinct_id === secondLaunch?.distinct_id),
);

// error-repeat
stop = await startServer("error-repeat", true);
await sleep(6_000);
await stop();
check(
  "error-repeat: the same error after a restart that day isn't sent again",
  !reportsIn("error-repeat").some(
    (event) =>
      (event.properties.$exception_list as ReadonlyArray<{ value: string }>)[0]?.value ===
      "Failed to decode provider instance config",
  ),
  { received: reportsIn("error-repeat").length },
);
writeBrokenProviderInstance(false);

// no-key
NodeFS.rmSync(idPath, { force: true });
NodeFS.rmSync(statePath, { force: true });
stop = await startServer("no-key", false);
await sleep(5_000);
await stop();
check("no-key: a build without a PostHog key sends nothing", eventsIn("no-key").length === 0);
check("no-key: no id or state file is created", readId() === null && !NodeFS.existsSync(statePath));

ingest.close();
const failed = checks.filter((entry) => !entry.pass);
NodeFS.writeFileSync(
  NodePath.join(out, "summary.json"),
  JSON.stringify({ passed: failed.length === 0, checks }, null, 2),
);
console.log(`${checks.length - failed.length}/${checks.length} checks passed. Evidence in ${out}`);
process.exit(failed.length === 0 ? 0 : 1);
