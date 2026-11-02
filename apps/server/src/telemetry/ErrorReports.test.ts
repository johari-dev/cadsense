// @effect-diagnostics preferSchemaOverJson:off globalErrorInEffectFailure:off
/**
 * Turning error logs into reports. Ways it could go wrong:
 *
 * - a local path in the log message leaves the app (C:\Users\<name>\..., /home/<name>/...)
 * - the error's own message, which can quote a prompt or file contents, is sent
 * - a stack frame carries a full path instead of a file name
 * - a multiline error message with frame-like lines is parsed as frames, leaking the message
 * - an error passed straight to logError (`tapError(Effect.logError)`) loses its type and stack
 * - warnings and info logs are reported, which is noise and costs quota
 * - an error log without a cause is dropped instead of reported
 * - a tagged error reports as plain "Error", so unrelated failures group together
 * - the inbox grows without bound when nothing drains it (dev builds, opted-out installs)
 */
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

import * as ErrorReports from "./ErrorReports.ts";

class ProbeFailedError extends Schema.TaggedErrorClass<ProbeFailedError>()("ProbeFailedError", {
  detail: Schema.String,
}) {}

const withReportLogger = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provide(Logger.layer([ErrorReports.logger])));

it.effect("reports an error log as its tag, the code's message, and file-name frames", () =>
  Effect.gen(function* () {
    ErrorReports.takeReports();
    const error = new ProbeFailedError({ detail: "prompt: make the bracket thicker" });
    yield* Effect.logError(
      "Probe failed for C:\\Users\\ada\\robot\\arm.step and /home/ada/robot",
      Cause.fail(error),
    ).pipe(withReportLogger);

    const [report, ...rest] = ErrorReports.takeReports();
    assert.lengthOf(rest, 0);
    assert.equal(report?.report.type, "ProbeFailedError");
    assert.equal(report?.report.value, "Probe failed for <path> and <path>");
    const serialized = JSON.stringify(report);
    assert.notInclude(serialized, "make the bracket thicker");
    assert.notInclude(serialized, "ada");
    const frames = report?.report.stacktrace.frames ?? [];
    assert.isAbove(frames.length, 0);
    assert.isTrue(frames.every((frame) => !/[\\/]/.test(frame.filename)));
    assert.isTrue(frames.some((frame) => frame.filename === "ErrorReports.test.ts"));
  }),
);

it.effect("never reads frames out of the error's message", () =>
  Effect.gen(function* () {
    ErrorReports.takeReports();
    const error = new Error("first line\n    at private prompt text (/home/ada/private.step:1:2)");
    yield* Effect.logError("Probe failed", Cause.fail(error)).pipe(withReportLogger);
    const serialized = JSON.stringify(ErrorReports.takeReports());
    assert.notInclude(serialized, "private");
  }),
);

it.effect("reports an error passed straight to logError as its class and frames", () =>
  Effect.gen(function* () {
    ErrorReports.takeReports();
    yield* Effect.fail(new TypeError("secret detail")).pipe(
      Effect.tapError(Effect.logError),
      Effect.ignore,
      withReportLogger,
    );
    const [held] = ErrorReports.takeReports();
    assert.equal(held?.report.type, "TypeError");
    assert.isAbove(held?.report.stacktrace.frames.length ?? 0, 0);
    assert.notInclude(JSON.stringify(held), "secret detail");
  }),
);

it.effect("reports an error log without a cause, and ignores warnings", () =>
  Effect.gen(function* () {
    ErrorReports.takeReports();
    yield* Effect.logWarning("Provider probe was slow").pipe(withReportLogger);
    yield* Effect.logError("Failed to decode provider instance config", {
      detail: "Expected string, got 123",
    }).pipe(withReportLogger);

    const reports = ErrorReports.takeReports();
    assert.deepEqual(
      reports.map(({ report }) => [report.type, report.value, report.mechanism.synthetic]),
      [["Error", "Failed to decode provider instance config", true]],
    );
    assert.notInclude(JSON.stringify(reports), "Expected string");
  }),
);

it.effect("keeps the same failure's reports under one fingerprint", () =>
  Effect.gen(function* () {
    ErrorReports.takeReports();
    const logOnce = Effect.logError(
      "Probe failed",
      Cause.fail(new ProbeFailedError({ detail: "" })),
    );
    yield* logOnce.pipe(withReportLogger);
    yield* logOnce.pipe(withReportLogger);
    const [first, second] = ErrorReports.takeReports();
    assert.equal(first?.fingerprint, second?.fingerprint);
  }),
);

it.effect("holds a bounded number of reports until they are taken", () =>
  Effect.gen(function* () {
    ErrorReports.takeReports();
    for (let index = 0; index < 100; index++) {
      yield* Effect.logError(`Failure ${index}`).pipe(withReportLogger);
    }
    assert.lengthOf(ErrorReports.takeReports(), ErrorReports.MAX_HELD_REPORTS);
    assert.lengthOf(ErrorReports.takeReports(), 0);
  }),
);
