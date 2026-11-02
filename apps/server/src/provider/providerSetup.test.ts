/**
 * How setup attempts count toward usage analytics. Ways the counting could go wrong:
 *
 * - a failed sign-in or install isn't counted, or counts as ok
 * - a sign-in whose command failed but still signed the account in counts as failed
 * - a sign-in the CLI can't confirm (its account check timed out) counts as ok
 *
 * An attempt replaced by a newer one is interrupted, so it never reaches either count.
 * The commands are real child processes (this Node binary), so each attempt goes through the
 * runner's own exit-code and re-probe decisions.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderAuthStatus,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { DailyCounter } from "../telemetry/AnalyticsEvents.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "./testUtils/providerRegistryMock.ts";
import { make, type ProviderSetupCommand } from "./providerSetup.ts";

const CODEX = ProviderDriverKind.make("codex");
const instanceId = defaultInstanceIdForDriver(CODEX);
const node = (script: string): ProviderSetupCommand => ({
  executable: process.execPath,
  args: ["-e", script],
});
const EXIT_OK = node("");
const EXIT_FAILED = node("process.exit(1)");

const provider = (auth: ServerProviderAuthStatus): ServerProvider => ({
  instanceId,
  driver: CODEX,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: auth },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

/** A runner whose sign-ins run each of `signIns` in turn; the CLI then reports `authAfter`. */
const harness = Effect.fn(function* (options: {
  readonly signIns?: ReadonlyArray<ProviderSetupCommand>;
  readonly install?: ProviderSetupCommand;
  readonly authAfter: ServerProviderAuthStatus;
}) {
  const counted = yield* Ref.make<DailyCounter[]>([]);
  const signIns = yield* Ref.make(options.signIns ?? [EXIT_OK]);
  const registry = makeProviderRegistryMock([provider(options.authAfter)]);
  const runner = yield* make().pipe(
    Effect.provideService(ProviderRegistry, {
      ...registry,
      getProviderSetupCommands: () =>
        Ref.modify(signIns, ([next = EXIT_OK, ...rest]) => [
          { install: options.install ?? EXIT_OK, signIn: next },
          rest,
        ]),
    }),
    Effect.provideService(
      AnalyticsService,
      AnalyticsService.of({
        count: (counter) => Ref.update(counted, (values) => [...values, counter]),
        reach: () => Effect.void,
        flush: Effect.void,
      }),
    ),
  );
  return { runner, counted };
});

it.layer(NodeServices.layer)("ProviderSetupRunner analytics", (it) => {
  it.effect("counts a sign-in by whether the CLI ends up signed in", () =>
    Effect.gen(function* () {
      const failed = yield* harness({ signIns: [EXIT_FAILED], authAfter: "unauthenticated" });
      yield* failed.runner.run({ instanceId, action: "signIn" }).pipe(Effect.flip);
      assert.deepEqual(yield* Ref.get(failed.counted), ["provider_signins_failed"]);

      // The command failed, but the account is signed in, so the attempt worked.
      const recovered = yield* harness({ signIns: [EXIT_FAILED], authAfter: "authenticated" });
      yield* recovered.runner.run({ instanceId, action: "signIn" });
      assert.deepEqual(yield* Ref.get(recovered.counted), ["provider_signins_ok"]);

      // The command worked, but the CLI's account check timed out: nothing is confirmed.
      const unconfirmed = yield* harness({ signIns: [EXIT_OK], authAfter: "unknown" });
      yield* unconfirmed.runner.run({ instanceId, action: "signIn" });
      assert.deepEqual(yield* Ref.get(unconfirmed.counted), []);
    }),
  );

  it.effect("counts a failed install", () =>
    Effect.gen(function* () {
      const h = yield* harness({ install: EXIT_FAILED, authAfter: "unauthenticated" });
      yield* h.runner.run({ instanceId, action: "install" }).pipe(Effect.flip);
      assert.deepEqual(yield* Ref.get(h.counted), ["provider_installs_failed"]);
    }),
  );
});
