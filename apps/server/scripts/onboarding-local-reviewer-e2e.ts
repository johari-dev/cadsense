// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off globalTimers:off globalFetch:off
/**
 * End-to-end check of onboarding's first step, "Connect an AI reviewer", for a reviewer that needs
 * no account. Codex pointed at a local model provider (`model_provider = "ollama"`, what
 * `codex --oss` uses) has nobody signed in, and its CLI says no sign-in is needed. Onboarding must
 * count it as connected and move on to "Add your CAD", not ask the user to sign in to ChatGPT.
 *
 * Starts the dev server and web app twice, each on a fresh data directory, drives headless
 * Chromium, and keeps the evidence under --out:
 *
 *   <case>/onboarding.png   the onboarding screen once the provider checks finished
 *   <case>/dev.log          dev runner, server, and web output
 *   summary.json            each check with pass/fail and the text it read
 *
 *   node apps/server/scripts/onboarding-local-reviewer-e2e.ts --out .cadsense/onboarding-local-e2e/run
 *
 * Cases:
 *   local-codex   Codex on the built-in ollama provider, Claude signed out. Step 1 is done and
 *                 labelled Codex, with no sign-in button, and step 2 is open.
 *   signed-out    Both CLIs signed out with default config. Step 1 still asks for a sign-in, so
 *                 the rule did not become "anything installed counts".
 *
 * Both CLIs get empty config folders under --out (CODEX_HOME and CLAUDE_CONFIG_DIR), and every
 * CLAUDE_*, ANTHROPIC_*, CODEX_* and OPENAI_* variable is removed from the environment, so this
 * machine's real accounts are never read. Nothing is clicked that starts a sign-in, and no local
 * model server has to be running: the check only reads what the Codex CLI reports about its account.
 *
 * Chromium comes from CADSENSE_CHROMIUM_PATH or Playwright's browser cache. The codex and claude
 * CLIs must be on PATH.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { isolatedCliEnv, parseE2eArgs, runE2e, waitFor } from "./e2e-harness.ts";

const { out } = parseE2eArgs("--out <dir>", {});

await runE2e(out, async (run) => {
  const { check } = run;
  const browser = await run.launchChromium();

  /** Starts the app on a fresh data directory and returns onboarding's text once step 1 settled. */
  const onboardingFor = async (
    name: string,
    codexConfig: string | null,
    extraEnv: Record<string, string> = {},
  ) => {
    const dir = NodePath.join(out, name);
    const env = { ...isolatedCliEnv(dir), ...extraEnv };
    if (codexConfig !== null) {
      NodeFS.writeFileSync(NodePath.join(dir, "codex-home", "config.toml"), codexConfig);
    }
    const app = await run.startDevApp({
      home: NodePath.join(dir, "home"),
      logPath: NodePath.join(dir, "dev.log"),
      env,
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    try {
      await page.goto(app.url, { waitUntil: "networkidle" });
      // Until Codex's first live check lands, onboarding shows its pending snapshot, which looks
      // signed out. The server saves each checked snapshot; a pending one has status "warning".
      const codexSnapshot = NodePath.join(dir, "home", "caches", "codex.json");
      await waitFor(`${name}: Codex's first status check`, () => {
        if (!NodeFS.existsSync(codexSnapshot)) return undefined;
        const status = (
          JSON.parse(NodeFS.readFileSync(codexSnapshot, "utf8")) as { status?: string }
        ).status;
        return status === "ready" || status === "error" ? status : undefined;
      });
      // Step 1 has settled once it offers a sign-in or has moved on to the CAD step.
      const signIn = page.getByRole("button", { name: "Sign in to ChatGPT" });
      const fileTab = page.getByText("File on this computer", { exact: true });
      const state = await waitFor(
        `${name}: the reviewer step to settle`,
        async () =>
          (await fileTab.isVisible())
            ? "add-cad"
            : (await signIn.isVisible())
              ? "sign-in"
              : undefined,
        120_000,
      );
      await page.waitForTimeout(500);
      await page.screenshot({ path: NodePath.join(dir, "onboarding.png") });
      const text = (await page.locator("main").first().innerText()).split("\n").filter(Boolean);
      return { state, text };
    } finally {
      await page.close();
      await app.stop();
    }
  };

  // A closed port: the check must not depend on a local model server being up.
  const local = await onboardingFor(
    "local-codex",
    'model_provider = "ollama"\nmodel = "qwen3:8b"\n',
    { CODEX_OSS_PORT: "9" },
  );
  check(
    "Codex on a local provider counts as a connected reviewer",
    local.state === "add-cad",
    local,
  );
  check(
    "the connected reviewer is labelled Codex, not ChatGPT",
    local.text.includes("Codex") && !local.text.includes("ChatGPT"),
    { text: local.text },
  );
  check(
    "onboarding does not ask a local Codex user to sign in",
    !local.text.some((line) => line.startsWith("Sign in to")),
    { text: local.text },
  );

  const signedOut = await onboardingFor("signed-out", null);
  check(
    "a signed-out reviewer still gets the sign-in step",
    signedOut.state === "sign-in",
    signedOut,
  );
});
