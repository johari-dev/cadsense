// @effect-diagnostics globalFetch:off - talks to Onshape directly, outside any Effect runtime.
// @effect-diagnostics nodeBuiltinImport:off - resolves the recordings directory from the command line.
/**
 * Records conformance cases in real Onshape (see `Recorder.ts`). Run by hand from the repo root;
 * it needs the network and an API key file holding `accessKeyId` and `secretKey`:
 *
 *   ONSHAPE_KEY_FILE=<key.json> node packages/featurescript/conformance/record.ts [--case name]... [--dry-run] [--recordings dir]
 *
 * `--dry-run` lists the cases without a current recording and about how many API calls they take.
 * Everything runs inside `runRedacted`, the only thing that prints: no line, error, rejection or
 * crash report carries the key once it's read. A key file that doesn't parse, or whose id or secret
 * is under 8 characters, is refused without printing it.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { RECORDINGS_DIR } from "./Case.ts";
import { CASES } from "./cases/index.ts";
import { estimateCalls, pendingCases, recordCases } from "./Recorder.ts";
import { readCredentials, runRedacted } from "./Redaction.ts";

await runRedacted(async ({ print, protect }) => {
  const { values } = NodeUtil.parseArgs({
    options: {
      case: { type: "string", multiple: true, default: [] },
      "dry-run": { type: "boolean", default: false },
      recordings: { type: "string" },
    },
  });
  const dir = values.recordings
    ? NodeURL.pathToFileURL(`${NodePath.resolve(values.recordings)}/`)
    : RECORDINGS_DIR;
  const unknown = values.case.filter((name) => !CASES.some((c) => c.name === name));
  if (unknown.length) throw new Error(`No such case: ${unknown.join(", ")}`);
  const selected = values.case.length ? CASES.filter((c) => values.case.includes(c.name)) : CASES;
  const pending = pendingCases(selected, dir);
  print(
    `${pending.length} of ${CASES.length} cases to record, about ${estimateCalls(pending, dir)} API calls.`,
  );
  for (const c of pending) print(`  ${c.name}`);
  if (values["dry-run"] || pending.length === 0) return 0;

  const keyFile = process.env.ONSHAPE_KEY_FILE;
  if (!keyFile) throw new Error("Set ONSHAPE_KEY_FILE to the API key JSON file.");
  const credentials = readCredentials(keyFile);
  protect(credentials);
  const summary = await recordCases(pending, {
    fetch: (url, init) => fetch(url, init),
    credentials,
    dir,
    log: print,
  });
  print(
    `${summary.recorded.length} recorded, ${Object.keys(summary.failed).length} failed (see failures.json), ${summary.calls} API calls.`,
  );
  if (summary.document)
    print(
      `Scratch document: https://cad.onshape.com/documents/${summary.document.id}/w/${summary.document.workspace}`,
    );
  if (summary.stopped) {
    print(`Stopped: ${summary.stopped}`);
    return 1;
  }
  return 0;
});
