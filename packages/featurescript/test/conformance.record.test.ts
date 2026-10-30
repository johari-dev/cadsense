// @effect-diagnostics nodeBuiltinImport:off - the recorder writes to a temporary directory here.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";
import {
  caseHash,
  loadRecording,
  readRecording,
  type ConformanceCase,
} from "../conformance/Case.ts";
import { CASES } from "../conformance/cases/index.ts";
import { fromOnshape, onshapeValue, type Plain } from "../conformance/Plain.ts";
import {
  CredentialEchoError,
  entityId,
  evaluation,
  OnshapeClient,
  ResponseError,
} from "../conformance/OnshapeApi.ts";
import { DOCUMENT_NAME, pendingCases, recordCases } from "../conformance/Recorder.ts";
import * as S from "../conformance/Schema.ts";
import {
  credentials,
  describeThrown,
  readCredentials,
  type Credentials,
} from "../conformance/Redaction.ts";

/**
 * How the recorder could touch documents it mustn't, or keep wrong ground truth. Each is guarded
 * below against a fake Onshape that logs every request; nothing here uses the network.
 *
 * 1. Cached ids that aren't the scratch document (another name, another creator or owner, or a
 *    workspace from another document) get features added or scripts evaluated in them.
 * 2. A document found by name that someone else created or owns is used.
 * 3. A query input whose resolution comes back malformed (no result, not a list, the wrong
 *    length, ids that aren't strings) or empty is added anyway, so the recording describes a
 *    different feature.
 * 4. A probe that fails (HTTP 500, or a result that doesn't decode) is saved as a recording, and
 *    the case is never recorded again.
 * 5. A 402 or 429 doesn't stop the run at once.
 * 6. A recorded case is recorded again, or an unchanged source uploaded again.
 * 7. A source Onshape doesn't compile isn't recorded as such.
 * 8. A response that echoes the credentials (the Authorization value, its token, or the key id or
 *    secret inside it) gets them into a file, a log line or the run summary.
 * 9. A document search that comes back malformed, or with more pages, ends in a second document.
 * 10. A malformed encoded value (a string without its text, a map whose entries aren't a list, a
 *     type Onshape doesn't have) decodes to a default, and the default is recorded.
 * 11. A probe result without its statuses, bodies, variables and values is recorded, or with fewer
 *     statuses than the case has features (the probe reads one per feature, "<error>" if it
 *     can't).
 * 12. A feature-spec response without its spec list is recorded as a compile failure, and later
 *     cases with the same source inherit it.
 * 13. A fetch that rejects, with the request's headers in its cause, gets them into a thrown error,
 *     the run summary or a file.
 * 14. The command line prints a credential from anything that escapes the recorder: an error, its
 *     stack or cause chain, an unhandled rejection, or a process warning.
 * 15. A key whose id or secret is too short to redact safely (under 8 characters), or a key file
 *     that doesn't parse, is used, or its contents are printed.
 * 16. A search candidate with the scratch name but no owner, creator or workspace data counts as
 *     absent, and a second document is created.
 * 17. A spec whose feature type isn't an identifier is cached as a compile failure.
 * 18. A probe whose bodies, statuses, variables or values don't match the probe schema is recorded,
 *     or a recording file that doesn't match it loads.
 * 19. An id from a response or the state file (user, document, workspace, element, microversion,
 *     feature, entity) that isn't in Onshape's format ends up in a request path or script, so a
 *     `../` in it points the request at another document.
 * 20. An echoed credential reaches disk in another form: base64 wrapped across lines, \uXXXX
 *     escapes, percent-encoding; or any response body is written to disk at all.
 * 21. A probe missing a requested value, or a body without the measurement its type needs (a
 *     solid's volume, a sheet's area, a wire's length), is recorded.
 * 23. A value Onshape withheld as too big to send is recorded as a placeholder, so the case is
 *     never recorded again and the comparison blames an area for it.
 * 24. A remembered element that's been deleted (the Part Studio for cases without features, or a
 *     Feature Studio) fails every case that uses it, forever; or gets made again in a loop.
 * 25. A response holds the key in a spelling the write gate can't see once the recorder has decoded
 *     it, such as wrapped base64 in a map key that isn't a string (decoding turns the key into JSON
 *     text, where a newline is `\n`), and it's recorded.
 * 26. A crash report prints part of the key through a line that only looks like a stack frame: one
 *     an error's name or message forges (with an empty message, or a name that repeats the
 *     message), wrapped so that no single printed line holds all of it. Or a name or message that
 *     isn't a string crashes the report, which then shows the printer's error instead. Or a thrown
 *     value, rejection or cause that isn't an Error is inspected first, which spells a newline as
 *     `\n` and doubles backslashes, so the check on the inspected text misses the key. Or reading
 *     the error throws (a getter, a proxy), the report throws in turn, and Node prints that raw.
 * 27. A deeply nested body (thousands of levels) overflows a recursive check or decoder, so the
 *     run dies as if the recorder had a bug instead of refusing the response.
 * 28. Onshape spells a value type another documented way (fully qualified, as in its Features docs
 *     example, or without the -N suffix), so every probe fails as if malformed and nothing records;
 *     or an undocumented spelling is accepted.
 * 22. A recording made before its case changed (other values, a newer probe) is decoded against the
 *     current case and throws, so the recorder and the offline suite crash instead of calling it
 *     stale.
 */

const named = (name: string): ConformanceCase =>
  CASES.find((candidate) => candidate.name === name)!;

/** A 24-character hex id, like Onshape's, made from a readable label. */
const hexId = (label: string) => Buffer.from(label).toString("hex").padEnd(24, "0").slice(0, 24);
const SCRATCH = hexId("scratch");
const SCRATCH_WORKSPACE = hexId("wscratch");
/** An id that, unchecked in a path, walks to another document. */
const TRAVERSAL = `${hexId("ws")}/../../../../d/111111111111111111111111/w/222222222222222222222222`;

/** Onshape's encoding of a plain value, as its FeatureScript endpoint returns it. */
function encode(value: Plain): unknown {
  if (value === null) return { btType: "BTFSValueUndefined-2003" };
  if (typeof value === "number") return { btType: "BTFSValueNumber-772", value };
  if (typeof value === "string") return { btType: "BTFSValueString-1422", value };
  if (typeof value === "boolean") return { btType: "BTFSValueBoolean-1195", value };
  if (Array.isArray(value)) return { btType: "BTFSValueArray-1499", value: value.map(encode) };
  return {
    btType: "BTFSValueMap-2062",
    value: Object.entries(value).map(([key, entry]) => ({
      btType: "BTFSValueMapEntry-2077",
      key: encode(key),
      value: encode(entry),
    })),
  };
}

/** The value names a probe script asks for. */
const requestedValues = (script: string) =>
  [...script.matchAll(/result\.values\[("[^"]*")\] =/g)].map(
    (match) => JSON.parse(match[1]!) as string,
  );
/** The features a probe script reads statuses for (its `const features = [makeId(...), ...]`). */
const probedFeatures = (script: string) =>
  [...(/const features = \[(.*)\];/.exec(script)?.[1]?.matchAll(/makeId\(/g) ?? [])].length;
/** A probe answer with an OK status per feature, no bodies, and 0 for every requested value. */
const emptyProbe = (script: string): Plain => ({
  statuses: Array.from({ length: probedFeatures(script) }, () => ({ type: "OK" })),
  bodies: [],
  variables: {},
  values: Object.fromEntries(requestedValues(script).map((name) => [name, 0])),
});

interface FakeDocument {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly owner: string;
  readonly workspace: string;
}
type Reply = { readonly status: number; readonly json: unknown };

/** Just enough of Onshape's API for the recorder, logging each request. */
class FakeOnshape {
  readonly me = hexId("me");
  readonly requests: {
    readonly method: string;
    readonly url: string;
    readonly path: string;
    readonly body: unknown;
  }[] = [];
  readonly documents: FakeDocument[] = [];
  /** Replies to a script that resolves query inputs; by default one entity per query. */
  queries = (script: string): Reply => ({
    status: 200,
    json: {
      result: encode(
        script
          .split("transientQueriesToStrings")
          .slice(1)
          .map(() => ["JHD"]),
      ),
    },
  });
  probe = (script: string): Reply => ({
    status: 200,
    json: { result: encode(emptyProbe(script)), libraryVersion: 3095, notices: [] },
  });
  /** Whether a Feature Studio with this source compiles. */
  compiles = (_source: string) => true;
  /** Requests after this many get HTTP 402, with this body. */
  quotaAfter = Number.POSITIVE_INFINITY;
  quotaReply: unknown = { message: "API limit exceeded" };
  /** Replies to a document search, before the default one; `undefined` falls through. */
  search: ((path: string) => Reply | undefined) | null = null;
  /** Replies to a feature-spec request (given its path), before the default one; `undefined` falls through. */
  specs: ((path: string) => Reply | undefined) | null = null;
  /** Answers a request before the routes do; `undefined` falls through. */
  intercept: ((method: string, path: string) => Reply | undefined) | null = null;
  /** Rewrites any reply's body, to plant a malformed field. */
  tamper: ((method: string, path: string, json: unknown) => unknown) | null = null;
  private readonly studios = new Map<string, string>();
  /** Elements this fake created; others get 404, as a deleted element does. */
  private readonly elements = new Set<string>();
  private next = 1;

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace("https://cad.onshape.com/api/v10", "");
    const method = init.method ?? "GET";
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    this.requests.push({ method, url, path, body });
    const reply =
      this.requests.length > this.quotaAfter
        ? { status: 402, json: this.quotaReply }
        : (this.intercept?.(method, path) ?? this.route(method, path, body));
    const json = this.tamper ? this.tamper(method, path, reply.json) : reply.json;
    return new Response(JSON.stringify(json), { status: reply.status });
  };

  private info = (document: FakeDocument) => ({
    id: document.id,
    name: document.name,
    createdBy: { id: document.createdBy },
    owner: { id: document.owner, type: 0 },
    defaultWorkspace: { id: document.workspace },
  });

  private route(method: string, path: string, body: unknown): Reply {
    const field = (key: string) => (body as Record<string, unknown>)[key];
    if (path === "/users/sessioninfo") return { status: 200, json: { id: this.me } };
    const searched =
      method === "GET" && path.startsWith("/documents?") ? this.search?.(path) : undefined;
    if (searched) return searched;
    if (method === "GET" && path.startsWith("/documents?"))
      return {
        status: 200,
        json: { items: this.documents.filter((d) => d.name === DOCUMENT_NAME).map(this.info) },
      };
    const document = /^\/documents\/(\w+)$/.exec(path);
    if (method === "GET" && document) {
      const found = this.documents.find((d) => d.id === document[1]);
      return found ? { status: 200, json: this.info(found) } : { status: 404, json: {} };
    }
    if (method === "POST" && path === "/documents") {
      const created = {
        id: hexId(`doc${this.next++}`),
        name: String(field("name")),
        createdBy: this.me,
        owner: field("ownerType") === 0 ? String(field("ownerId")) : hexId("company"),
        workspace: hexId(`ws${this.next++}`),
      };
      this.documents.push(created);
      return { status: 200, json: this.info(created) };
    }
    if (/^\/(featurestudios|partstudios)\/d\/\w+\/w\/\w+$/.test(path)) {
      const id = hexId(`e${this.next++}`);
      this.elements.add(id);
      return { status: 200, json: { id } };
    }
    const element = /^\/(?:partstudios|featurestudios)\/d\/\w+\/w\/\w+\/e\/(\w+)/.exec(path);
    if (element && !this.elements.has(element[1]!)) return { status: 404, json: {} };
    const studio = /^\/featurestudios\/d\/\w+\/w\/\w+\/e\/(\w+)(\/featurespecs)?$/.exec(path);
    if (studio && method === "POST") {
      this.studios.set(studio[1]!, String(field("contents")));
      return { status: 200, json: {} };
    }
    const specs = studio ? this.specs?.(path) : undefined;
    if (specs) return specs;
    if (studio) {
      const source = this.studios.get(studio[1]!) ?? "";
      const types = this.compiles(source)
        ? [...source.matchAll(/export const (\w+) = defineFeature/g)].map((match) => match[1])
        : [];
      return {
        status: 200,
        json: {
          featureSpecs: types.map((featureType) => ({
            featureType,
            namespace: `e${studio[1]}::m${hexId("mv")}`,
            parameters: [],
          })),
        },
      };
    }
    if (path.endsWith("/features"))
      return {
        status: 200,
        json: { feature: { featureId: `F${this.next++}` }, featureState: { featureStatus: "OK" } },
      };
    if (path.endsWith("/featurescript")) {
      const script = String(field("script"));
      return script.includes("transientQueriesToStrings")
        ? this.queries(script)
        : this.probe(script);
    }
    return { status: 404, json: { message: `no route for ${method} ${path}` } };
  }

  /** Deletes an element, as someone could in the scratch document: later requests to it get 404. */
  deleteElement(id: string) {
    this.elements.delete(id);
  }

  /** Requests that write to or evaluate in a document: everything under /featurestudios and /partstudios. */
  touched(documentId: string) {
    return this.requests.filter((request) => request.path.includes(`/d/${documentId}/`));
  }
}

/** A fresh recordings directory, optionally with a state file. */
function directory(state?: unknown): URL {
  const dir = NodeURL.pathToFileURL(
    `${NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-"))}/`,
  );
  if (state) NodeFS.writeFileSync(new URL("onshape.json", dir), JSON.stringify(state));
  return dir;
}
/** A synthetic key: long enough to be accepted, never a real one. */
const TEST_KEY = credentials(
  "TESTACCESSKEYID000000000",
  "TESTSECRETKEY000000000000000000000000000000",
);
const record = (
  onshape: FakeOnshape,
  dir: URL,
  cases: readonly ConformanceCase[],
  options: { readonly credentials?: Credentials; readonly log?: (line: string) => void } = {},
) =>
  recordCases(cases, {
    fetch: onshape.fetch,
    credentials: options.credentials ?? TEST_KEY,
    dir,
    retryDelayMs: 0,
    ...(options.log ? { log: options.log } : {}),
  });
/** Every string in `value`, keys included. */
const stringsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsIn)
      : typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, entry]) => [key, ...stringsIn(entry)])
        : [];
/**
 * Every file the recorder wrote under `dir`, as text: each file's raw text, and each string inside
 * it as JSON decodes it, since a real newline in a string is `\n` in the file.
 */
const written = (dir: URL): string =>
  (NodeFS.readdirSync(dir, { recursive: true }) as string[])
    .map((file) => new URL(file, dir))
    .filter((url) => NodeFS.statSync(url).isFile())
    .flatMap((url) => {
      const text = NodeFS.readFileSync(url, "utf8");
      let strings: string[] = [];
      try {
        strings = stringsIn(JSON.parse(text));
      } catch {
        strings = [];
      }
      return [text, ...strings];
    })
    .join("\n");
const failures = (dir: URL): Record<string, { readonly code: string }> =>
  JSON.parse(NodeFS.readFileSync(new URL("failures.json", dir), "utf8"));
const posts = (onshape: FakeOnshape, path: string) =>
  onshape.requests.filter((request) => request.method === "POST" && request.path === path);

/**
 * The spellings the recorder claims to catch, undone: whitespace (base64 wrapped across lines),
 * \uXXXX escapes and %XX escapes. Callers pass decoded strings (see {@link written}), not JSON.
 */
const unspelled = (text: string): string[] => {
  const compact = text.replace(/\s+/g, "");
  const unescaped = compact.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const decoded = unescaped.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return [text, compact, unescaped, decoded];
};
/** Every 20-character piece of `token`: a crash report must not print even part of it. */
const fragmentsOf = (token: string) =>
  Array.from({ length: token.length - 19 }, (_, i) => token.slice(i, i + 20));
/** The parts of a key that appear in `text`, in any spelling {@link unspelled} undoes. */
const leaksOf = (id: string, secret: string) => {
  const token = Buffer.from(`${id}:${secret}`).toString("base64");
  return (text: string) =>
    [token, `${id}:${secret}`, id, secret].filter((needle) =>
      unspelled(text).some((form) => form.includes(needle)),
    );
};

describe("conformance recorder", () => {
  const scratch = (onshape: FakeOnshape, overrides: Partial<FakeDocument> = {}): FakeDocument => {
    const document = {
      id: SCRATCH,
      name: DOCUMENT_NAME,
      createdBy: onshape.me,
      owner: onshape.me,
      workspace: SCRATCH_WORKSPACE,
      ...overrides,
    };
    onshape.documents.push(document);
    return document;
  };

  it.each([
    ["another name", { name: "Gearbox housing" }],
    ["another creator", { createdBy: hexId("someone") }],
    ["another owner", { owner: hexId("someone") }],
  ] as const)("never writes to a cached document with %s (1)", async (_, overrides) => {
    const onshape = new FakeOnshape();
    const other = scratch(onshape, { id: hexId("other"), ...overrides });
    const dir = directory({
      document: { id: other.id, workspace: other.workspace },
      studios: {},
      emptyPartStudio: hexId("eold"),
    });
    const summary = await record(onshape, dir, [
      named("lang-power"),
      named("context-default-planes"),
    ]);
    expect(summary.stopped).toBeNull();
    expect(onshape.touched(other.id)).toEqual([]);
    expect(onshape.requests.some((request) => request.path.includes(hexId("eold")))).toBe(false);
    expect(summary.document?.id).not.toBe(other.id);
    expect(posts(onshape, "/documents")).toHaveLength(1);
    expect(readRecording(named("lang-power"), dir)?.hash).toBe(caseHash(named("lang-power")));
  });

  it("never uses a cached workspace that isn't the scratch document's own (1)", async () => {
    const onshape = new FakeOnshape();
    const document = scratch(onshape);
    const foreign = hexId("wforeign");
    const dir = directory({
      document: { id: document.id, workspace: foreign },
      studios: {},
      emptyPartStudio: null,
    });
    const summary = await record(onshape, dir, [named("lang-power")]);
    expect(onshape.requests.some((request) => request.path.includes(foreign))).toBe(false);
    expect(summary.document).toEqual({ id: SCRATCH, workspace: SCRATCH_WORKSPACE });
    expect(posts(onshape, "/documents")).toHaveLength(0);
  });

  it("reuses cached ids that check out, without searching or creating (1)", async () => {
    const onshape = new FakeOnshape();
    const document = scratch(onshape);
    const dir = directory({
      document: { id: document.id, workspace: document.workspace },
      studios: {},
      emptyPartStudio: null,
    });
    const summary = await record(onshape, dir, [named("lang-power")]);
    expect(summary.document).toEqual({ id: SCRATCH, workspace: SCRATCH_WORKSPACE });
    expect(onshape.requests.some((request) => request.path.startsWith("/documents?"))).toBe(false);
    expect(posts(onshape, "/documents")).toHaveLength(0);
    expect(onshape.touched(SCRATCH).length).toBeGreaterThan(0);
  });

  it("ignores a same-named document someone else created or owns, and creates its own (2)", async () => {
    const onshape = new FakeOnshape();
    scratch(onshape, { id: hexId("theirs"), createdBy: hexId("someone"), owner: hexId("someone") });
    scratch(onshape, { id: hexId("shared"), owner: hexId("someone") });
    const summary = await record(onshape, directory(), [named("lang-power")]);
    expect(onshape.touched(hexId("theirs"))).toEqual([]);
    expect(onshape.touched(hexId("shared"))).toEqual([]);
    expect(posts(onshape, "/documents")[0]?.body).toMatchObject({
      name: DOCUMENT_NAME,
      isPublic: false,
      ownerType: 0,
      ownerId: onshape.me,
    });
    expect(summary.document?.id).toMatch(/^646f63/);
  });

  it.each([
    ["no result", { status: 200, json: {} }],
    ["a result that isn't a list", { status: 200, json: { result: encode("JHD") } }],
    ["the wrong number of entries", { status: 200, json: { result: encode([]) } }],
    ["ids that aren't strings", { status: 200, json: { result: encode([[1]]) } }],
    ["an empty selection", { status: 200, json: { result: encode([[]]) } }],
    ["HTTP 500", { status: 500, json: { message: "boom" } }],
  ] as const)(
    "stops a case whose query inputs resolve to %s before adding the feature (3)",
    async (_, reply) => {
      const onshape = new FakeOnshape();
      onshape.queries = () => reply;
      const dir = directory();
      const summary = await record(onshape, dir, [
        named("corpus-bolt-circle"),
        named("lang-power"),
      ]);
      const added = onshape.requests
        .filter((request) => request.path.endsWith("/features"))
        .map(
          (request) => (request.body as { feature: { featureType: string } }).feature.featureType,
        );
      expect(added).toEqual(["plate", "langPower"]);
      expect(readRecording(named("corpus-bolt-circle"), dir)).toBeNull();
      expect(failures(dir)["corpus-bolt-circle"]).toMatchObject({ code: /^QUERY_/, input: "face" });
      expect(summary.recorded).toEqual(["lang-power"]);
    },
  );

  it.each([
    ["HTTP 500", { status: 500, json: { message: "boom" } }],
    ["a result that doesn't decode", { status: 200, json: { notices: [] } }],
  ] as const)("keeps a case whose probe fails with %s pending (4)", async (_, reply) => {
    const onshape = new FakeOnshape();
    onshape.probe = () => reply;
    const dir = directory();
    await record(onshape, dir, [named("lang-power")]);
    expect(readRecording(named("lang-power"), dir)).toBeNull();
    expect(failures(dir)["lang-power"]?.code).toMatch(/^PROBE_/);

    const retry = new FakeOnshape();
    retry.documents.push(...onshape.documents);
    const summary = await record(retry, dir, [named("lang-power")]);
    expect(summary.recorded).toEqual(["lang-power"]);
    expect(readRecording(named("lang-power"), dir)?.hash).toBe(caseHash(named("lang-power")));
    expect(failures(dir)["lang-power"]).toBeUndefined();
  });

  it("stops at the first 402 (5)", async () => {
    const onshape = new FakeOnshape();
    onshape.quotaAfter = 4;
    const dir = directory();
    const summary = await record(onshape, dir, [named("lang-power"), named("lang-tilde")]);
    expect(summary.stopped).toMatch(/402/);
    expect(onshape.requests).toHaveLength(5);
    expect(readRecording(named("lang-power"), dir)).toBeNull();
  });

  it("records each case once and uploads each source once (6)", async () => {
    const onshape = new FakeOnshape();
    const dir = directory();
    const first = await record(onshape, dir, [named("lang-power"), named("lang-tilde")]);
    expect(first.recorded).toEqual(["lang-power", "lang-tilde"]);
    const uploads = onshape.requests.filter((request) =>
      /^\/featurestudios\/d\/\w+\/w\/\w+$/.test(request.path),
    );
    expect(uploads).toHaveLength(1);
    const before = onshape.requests.length;
    const second = await record(onshape, dir, [named("lang-power"), named("lang-tilde")]);
    expect(second).toMatchObject({ calls: 0, recorded: [] });
    expect(onshape.requests).toHaveLength(before);
  });

  it("never writes, logs or returns the credentials a response echoes (8)", async () => {
    const id = "AKEYIDAKEYIDAKEYID123456";
    const secret = "SECRETSECRETSECRETSECRETSECRETSECRETSECRET1234";
    const key = credentials(id, secret);
    const token = Buffer.from(`${id}:${secret}`).toString("base64");
    const echo = `proxy saw Basic ${token}; token ${token}; id ${id}; secret ${secret}`;
    const onshape = new FakeOnshape();
    onshape.queries = () => ({ status: 500, json: { message: echo } });
    onshape.probe = () => ({ status: 500, json: { message: echo, notices: [{ message: echo }] } });
    const lines: string[] = [];
    const dir = directory();
    const summary = await record(onshape, dir, [named("corpus-bolt-circle"), named("lang-power")], {
      credentials: key,
      log: (line) => lines.push(line),
    });
    const quota = new FakeOnshape();
    quota.quotaAfter = 0;
    quota.quotaReply = { message: echo };
    const quotaSummary = await record(quota, directory(), [named("lang-power")], {
      credentials: key,
    });
    expect(Object.keys(summary.failed)).toEqual(["corpus-bolt-circle", "lang-power"]);
    expect(quotaSummary.stopped).toMatch(/402/);
    const leaks = leaksOf(id, secret);
    for (const text of [
      written(dir),
      lines.join("\n"),
      JSON.stringify(summary),
      JSON.stringify(quotaSummary),
    ])
      expect(leaks(text)).toEqual([]);
  });

  it.each([
    ["no item list", () => ({ status: 200, json: { message: "not a document listing" } })],
    ["an item that isn't a document", () => ({ status: 200, json: { items: ["scratch"] } })],
    [
      "a next page on another host",
      () => ({
        status: 200,
        json: { items: [], next: "https://evil.example/api/v10/documents?offset=20" },
      }),
    ],
  ] as const)(
    "stops instead of creating a document when the search has %s (9)",
    async (_, reply) => {
      const onshape = new FakeOnshape();
      onshape.search = reply;
      const summary = await record(onshape, directory(), [named("lang-power")]);
      expect(summary.stopped).toMatch(/SEARCH/);
      expect(onshape.requests.some((request) => request.method === "POST")).toBe(false);
    },
  );

  it("follows search pages before creating a document, and finds the scratch one on a later page (9)", async () => {
    const onshape = new FakeOnshape();
    scratch(onshape);
    const theirs = (i: number) => ({
      id: hexId(`shared${i}`),
      name: DOCUMENT_NAME,
      createdBy: { id: hexId("someone") },
      owner: { id: hexId("someone") },
      defaultWorkspace: { id: hexId(`w${i}`) },
    });
    onshape.search = (path) =>
      path.includes("offset=20")
        ? undefined
        : {
            status: 200,
            json: {
              items: Array.from({ length: 20 }, (_, i) => theirs(i)),
              next: "https://cad.onshape.com/api/v10/documents?q=x&offset=20",
            },
          };
    const summary = await record(onshape, directory(), [named("lang-power")]);
    expect(summary.document).toEqual({ id: SCRATCH, workspace: SCRATCH_WORKSPACE });
    expect(posts(onshape, "/documents")).toHaveLength(0);

    const endless = new FakeOnshape();
    endless.search = (path) => ({
      status: 200,
      json: {
        items: [],
        next: `https://cad.onshape.com/api/v10/documents?q=x&offset=${Number(/offset=(\d+)/.exec(path)?.[1] ?? 0) + 20}`,
      },
    });
    const stopped = await record(endless, directory(), [named("lang-power")]);
    expect(stopped.stopped).toMatch(/SEARCH/);
    expect(endless.requests.length).toBeLessThan(60);
    expect(endless.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it.each([
    ["a string without its text", { btType: "BTFSValueString-1422" }],
    ["a number that isn't one", { btType: "BTFSValueNumber-772", value: "1" }],
    ["a boolean without its value", { btType: "BTFSValueBoolean-1195" }],
    ["a list whose value isn't a list", { btType: "BTFSValueArray-1499", value: "broken" }],
    ["a map whose entries aren't a list", { btType: "BTFSValueMap-2062", value: "broken" }],
    [
      "a map entry without a key",
      {
        btType: "BTFSValueMap-2062",
        value: [{ value: { btType: "BTFSValueNumber-772", value: 1 } }],
      },
    ],
    ["units without powers", { btType: "BTFSValueWithUnits-1817", value: 1 }],
    ["a type Onshape doesn't have", { btType: "BTFSValueSurprise-1", value: 1 }],
    ["a value Onshape withheld as too big", { btType: "BTFSValueTooBig-1247" }],
    ["no value at all", undefined],
  ] as const)("refuses to decode %s (10)", (_, encoded) => {
    expect(() => fromOnshape(encoded)).toThrow();
    expect(() => fromOnshape({ btType: "BTFSValueArray-1499", value: [encoded] })).toThrow();
  });

  describe("value type spellings (28)", () => {
    const QUALIFIED = "com.belmonttech.serialize.fsvalue.";
    /** `value`, encoded with every btType spelled by `spell` from its short name, e.g. "BTFSValueArray". */
    const respell = (value: unknown, spell: (short: string) => string): unknown => {
      if (Array.isArray(value)) return value.map((item) => respell(item, spell));
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(
        Object.entries(value).map(([field, inner]) => [
          field,
          field === "btType" && typeof inner === "string" && inner.startsWith("BTFSValue")
            ? spell(inner.replace(/-\d+$/, ""))
            : respell(inner, spell),
        ]),
      );
    };
    const sample = {
      btType: "BTFSValueMap-2062",
      value: [
        { key: encode("list"), value: encode([1, "two", true, null]) },
        {
          key: encode("length"),
          value: { btType: "BTFSValueWithUnits-1817", value: 0.01, unitToPower: { METER: 1 } },
        },
        { key: encode("other"), value: { btType: "BTFSValueOther-1124", type: "FUNCTION" } },
      ],
    };

    it.each([
      ["short with a number", (short: string) => `${short}-1888`],
      ["short without a number", (short: string) => short],
      ["fully qualified", (short: string) => `${QUALIFIED}${short}`],
    ] as const)("decodes every value type spelled %s the same way", (_, spell) => {
      const expected = fromOnshape(sample);
      expect(fromOnshape(respell(sample, spell))).toEqual(expected);
      expect(() => fromOnshape(respell({ btType: "BTFSValueTooBig-1247" }, spell))).toThrow(
        /withheld/,
      );
    });

    it("decodes Onshape's own Features docs example through the client", async () => {
      // https://onshape-public.github.io/docs/api-adv/featureaccess/ (API v9).
      const docsExample = {
        btType: "BTFeatureScriptEvalResponse-1859",
        result: {
          btType: `${QUALIFIED}BTFSValueArray`,
          value: [{ btType: `${QUALIFIED}BTFSValueString`, value: "JCC", typeTag: "" }],
          typeTag: "",
        },
      };
      const client = new OnshapeClient(
        async () => new Response(JSON.stringify(docsExample), { status: 200 }),
        TEST_KEY,
      );
      const { result } = await client.send("POST", "/x", evaluation);
      expect(S.array(entityId).decode(onshapeValue.decode(result, "result"), "result")).toEqual([
        "JCC",
      ]);
    });

    it.each([
      ["another package", "com.example.BTFSValueArray"],
      ["a partial package", "fsvalue.BTFSValueArray"],
      ["a suffix that isn't a number", "BTFSValueArray-x"],
      ["two suffixes", "BTFSValueArray-1499-2"],
      ["a qualified name with a suffix and a typo", `${QUALIFIED}BTFSValueArrays-1499`],
      ["an unknown type, qualified", `${QUALIFIED}BTFSValueSurprise`],
      ["the old type/typeName form", undefined],
    ] as const)("refuses %s", (_, btType) => {
      const value =
        btType === undefined
          ? { type: 1499, typeName: "BTFSValueArray", message: { value: [] } }
          : { btType, value: [] };
      expect(() => fromOnshape(value)).toThrow();
    });
  });

  it("doesn't record a case whose query ids or probe don't decode (10, 11)", async () => {
    const onshape = new FakeOnshape();
    onshape.queries = () => ({
      status: 200,
      json: {
        result: {
          btType: "BTFSValueArray-1499",
          value: [{ btType: "BTFSValueArray-1499", value: [{ btType: "BTFSValueString-1422" }] }],
        },
      },
    });
    const dir = directory();
    await record(onshape, dir, [named("corpus-bolt-circle")]);
    expect(readRecording(named("corpus-bolt-circle"), dir)).toBeNull();
    expect(onshape.requests.filter((request) => request.path.endsWith("/features"))).toHaveLength(
      1,
    );

    for (const result of [
      { btType: "BTFSValueMap-2062", value: "broken" },
      encode({}),
      encode({ statuses: [], bodies: [], variables: {} }),
      encode({ statuses: {}, bodies: [], variables: {}, values: {} }),
    ]) {
      const probe = new FakeOnshape();
      probe.probe = () => ({ status: 200, json: { result, libraryVersion: 3095 } });
      const probeDir = directory();
      await record(probe, probeDir, [named("context-default-planes")]);
      expect(readRecording(named("context-default-planes"), probeDir)).toBeNull();
      expect(failures(probeDir)["context-default-planes"]?.code).toMatch(/^PROBE_/);
    }
  });

  it("leaves cases pending when the feature specs are malformed, without caching the studio (12)", async () => {
    const onshape = new FakeOnshape();
    onshape.specs = () => ({ status: 200, json: { message: "temporary specs unavailable" } });
    const dir = directory();
    const summary = await record(onshape, dir, [named("lang-power"), named("lang-tilde")]);
    expect(summary.recorded).toEqual([]);
    expect(Object.keys(summary.failed)).toEqual(["lang-power", "lang-tilde"]);
    expect(readRecording(named("lang-power"), dir)).toBeNull();
    // The second case doesn't upload the same source again in this run.
    expect(
      onshape.requests.filter((request) => /^\/featurestudios\/d\/\w+\/w\/\w+$/.test(request.path)),
    ).toHaveLength(1);
    const state = JSON.parse(NodeFS.readFileSync(new URL("onshape.json", dir), "utf8"));
    expect(state.studios).toEqual({});

    onshape.specs = null;
    const retry = await record(onshape, dir, [named("lang-power"), named("lang-tilde")]);
    expect(retry.recorded).toEqual(["lang-power", "lang-tilde"]);
  });

  describe("credentials that escape (13, 14, 15)", () => {
    const id = "SYNTHETIC_ACCESS_KEY_12345";
    const secret = "SYNTHETIC_SECRET_KEY_12345";
    const leaks = leaksOf(id, secret);

    it("stops on a fetch that rejects with the request in its cause, without the credential (13)", async () => {
      for (const reject of [
        (init: RequestInit) =>
          Promise.reject(new Error("transport failed", { cause: { request: init } })),
        (init: RequestInit) => Promise.reject(new Headers(init.headers).get("Authorization")),
        (init: RequestInit) =>
          Promise.reject({
            headers: init.headers,
            nested: [new Error(`header ${new Headers(init.headers).get("Authorization")}`)],
          }),
      ]) {
        const dir = directory();
        const summary = await recordCases([named("lang-power")], {
          fetch: (_url, init) => reject(init),
          credentials: credentials(id, secret),
          dir,
          retryDelayMs: 0,
        });
        expect(summary.stopped).toMatch(/TRANSPORT_FAILED/);
        expect(leaks(NodeUtil.inspect(summary, { depth: 20 }))).toEqual([]);
        expect(leaks(written(dir))).toEqual([]);
      }
    });

    it("the command line prints no credential from an error, rejection or warning that escapes (14)", () => {
      const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-cli-"));
      const keyFile = NodePath.join(scratchDir, "key.json");
      NodeFS.writeFileSync(keyFile, JSON.stringify({ accessKeyId: id, secretKey: secret }));
      const cli = NodeURL.fileURLToPath(new URL("../conformance/record.ts", import.meta.url));
      let runs = 0;
      const run = (preload: string) => {
        const preloadFile = NodePath.join(scratchDir, `preload-${(runs += 1)}.mjs`);
        NodeFS.writeFileSync(preloadFile, preload);
        return NodeChildProcess.spawnSync(
          process.execPath,
          [
            "--import",
            preloadFile,
            cli,
            "--case",
            "lang-power",
            "--recordings",
            NodePath.join(scratchDir, "recordings"),
          ],
          { encoding: "utf8", env: { ...process.env, ONSHAPE_KEY_FILE: keyFile } },
        );
      };
      for (const preload of [
        // A rejection carrying the header in its cause.
        "globalThis.fetch = async (url, init) => { throw new Error('transport failure', { cause: { Authorization: init.headers.Authorization } }); };",
        // A rejection nobody awaits, with the header in its message and stack.
        "globalThis.fetch = (url, init) => { Promise.reject(new Error('late ' + init.headers.Authorization)); return new Promise(() => {}); };",
        // The header on what looks like a stack frame line of the message, and as the error's name.
        "globalThis.fetch = (url, init) => { Promise.reject(new Error('late\\n    at ' + init.headers.Authorization)); return new Promise(() => {}); };",
        "globalThis.fetch = (url, init) => { const e = new Error('late'); e.name = init.headers.Authorization; Promise.reject(e); return new Promise(() => {}); };",
        // A synchronous throw of a plain object holding the headers.
        "globalThis.fetch = (url, init) => { throw { headers: init.headers }; };",
        // Process warnings with the header, plain and wrapped across lines.
        "globalThis.fetch = async (url, init) => { const h = init.headers.Authorization; process.emitWarning(h); process.emitWarning(h.slice(0, 30) + '\\n' + h.slice(30), 'Echo'); await new Promise((resolve) => setImmediate(resolve)); throw new Error('transport failure'); };",
      ]) {
        const result = run(preload);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(leaks(output)).toEqual([]);
        expect(output).toMatch(/TRANSPORT_FAILED|withheld|Unexpected/);
      }
    });

    it("refuses short keys and key files that don't parse, without printing them (15)", () => {
      expect(() => credentials(id, "s3cr3t!")).toThrow(/at least 8/);
      expect(() => credentials("short", secret)).toThrow(/at least 8/);
      const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-key-"));
      const broken = NodePath.join(scratchDir, "broken.json");
      NodeFS.writeFileSync(broken, `{"accessKeyId": "${id}", "secretKey": "${secret}"`);
      expect(() => readCredentials(broken)).toThrow(/key file/);
      try {
        readCredentials(broken);
      } catch (error) {
        expect(leaks(NodeUtil.inspect(error, { depth: 20 }))).toEqual([]);
      }
      const short = NodePath.join(scratchDir, "short.json");
      NodeFS.writeFileSync(short, JSON.stringify({ accessKeyId: id, secretKey: "s3cr3t!" }));
      expect(() => readCredentials(short)).toThrow(/at least 8/);
    });
  });

  it("looks a same-named search result up before trusting it, and never creates a document while one is unverified (16)", async () => {
    const onshape = new FakeOnshape();
    scratch(onshape);
    onshape.search = () => ({
      status: 200,
      json: { items: [{ id: SCRATCH, name: DOCUMENT_NAME }], next: null },
    });
    const summary = await record(onshape, directory(), [named("lang-power")]);
    expect(summary.document).toEqual({ id: SCRATCH, workspace: SCRATCH_WORKSPACE });
    expect(
      onshape.requests.some(
        (request) => request.method === "GET" && request.path === `/documents/${SCRATCH}`,
      ),
    ).toBe(true);
    expect(posts(onshape, "/documents")).toHaveLength(0);

    const missing = new FakeOnshape();
    missing.search = () => ({
      status: 200,
      json: { items: [{ id: hexId("gone"), name: DOCUMENT_NAME }], next: null },
    });
    const stopped = await record(missing, directory(), [named("lang-power")]);
    expect(stopped.stopped).toContain(hexId("gone"));
    expect(missing.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("leaves a case pending when a spec's feature type isn't an identifier (17)", async () => {
    for (const featureType of ["", "not an identifier", 7]) {
      const onshape = new FakeOnshape();
      onshape.specs = () => ({
        status: 200,
        json: { featureSpecs: [{ featureType, parameters: [] }] },
      });
      const dir = directory();
      const summary = await record(onshape, dir, [named("lang-power")]);
      expect(summary.recorded).toEqual([]);
      expect(readRecording(named("lang-power"), dir)).toBeNull();
      const state = JSON.parse(NodeFS.readFileSync(new URL("onshape.json", dir), "utf8"));
      expect(state.studios).toEqual({});
    }
  });

  const solid = {
    types: ["SOLID"],
    sketch: false,
    construction: false,
    faces: 6,
    edges: 12,
    vertices: 8,
    box: [0, 0, 0, 1, 1, 1],
    volume: 1,
  };
  /** A case with no features that asks for `values`, to probe in the empty Part Studio. */
  const probeCase = (
    name: string,
    values: Readonly<Record<string, string>> = {},
  ): ConformanceCase => ({
    name,
    description: "test",
    covers: "test",
    area: "evaluators/queries",
    features: [],
    values,
  });

  it("refuses probes and recordings that don't match the probe schema (18)", async () => {
    const empty = { statuses: [], bodies: [], variables: {}, values: {} };
    for (const result of [
      { ...empty, bodies: [7] },
      { ...empty, bodies: [{ ...solid, faces: "6" }] },
      { ...empty, bodies: [{ ...solid, types: ["BLOB"] }] },
      { ...empty, bodies: [{ ...solid, box: [0, 0, 0] }] },
      { ...empty, statuses: [7] },
    ] satisfies Plain[]) {
      const onshape = new FakeOnshape();
      onshape.probe = () => ({
        status: 200,
        json: { result: encode(result), libraryVersion: 3095 },
      });
      const dir = directory();
      await record(onshape, dir, [named("lang-power")]);
      expect(readRecording(named("lang-power"), dir)).toBeNull();
      expect(failures(dir)["lang-power"]?.code).toMatch(/^PROBE_/);
    }

    const onshape = new FakeOnshape();
    onshape.probe = () => ({
      status: 200,
      json: {
        result: encode({
          ...empty,
          statuses: named("lang-power").features.map(() => ({ type: "OK" })),
          bodies: [solid],
        }),
        libraryVersion: 3095,
      },
    });
    const dir = directory();
    await record(onshape, dir, [named("lang-power")]);
    expect(readRecording(named("lang-power"), dir)?.probe?.result.bodies).toEqual([solid]);
    const file = new URL("lang-power.json", dir);
    const recording = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    recording.probe.result.bodies = [7];
    NodeFS.writeFileSync(file, JSON.stringify(recording));
    expect(() => readRecording(named("lang-power"), dir)).toThrow(/bodies/);
  });

  it.each([
    [
      "a user id",
      (method: string, path: string, json: unknown) =>
        path === "/users/sessioninfo" ? { id: TRAVERSAL } : json,
    ],
    [
      "a found document's id",
      (method: string, path: string, json: unknown) =>
        path.startsWith("/documents?")
          ? {
              items: [
                {
                  id: TRAVERSAL,
                  name: DOCUMENT_NAME,
                  createdBy: { id: hexId("me") },
                  owner: { id: hexId("me") },
                  defaultWorkspace: { id: SCRATCH_WORKSPACE },
                },
              ],
            }
          : json,
    ],
    [
      "a found document's workspace",
      (method: string, path: string, json: unknown) =>
        path.startsWith("/documents?")
          ? {
              items: [
                {
                  id: SCRATCH,
                  name: DOCUMENT_NAME,
                  createdBy: { id: hexId("me") },
                  owner: { id: hexId("me") },
                  defaultWorkspace: { id: TRAVERSAL },
                },
              ],
            }
          : json,
    ],
    [
      "a created document's id",
      (method: string, path: string, json: unknown) =>
        method === "POST" && path === "/documents" ? { ...(json as object), id: TRAVERSAL } : json,
    ],
    [
      "a created document's workspace",
      (method: string, path: string, json: unknown) =>
        method === "POST" && path === "/documents"
          ? { ...(json as object), defaultWorkspace: { id: TRAVERSAL } }
          : json,
    ],
    [
      "a Feature Studio's id",
      (method: string, path: string, json: unknown) =>
        method === "POST" && path.startsWith("/featurestudios/") && path.split("/").length === 6
          ? { id: TRAVERSAL }
          : json,
    ],
    [
      "a Part Studio's id",
      (method: string, path: string, json: unknown) =>
        method === "POST" && path.startsWith("/partstudios/") && path.split("/").length === 6
          ? { id: TRAVERSAL }
          : json,
    ],
    [
      "a namespace",
      (method: string, path: string, json: unknown) =>
        path.endsWith("/featurespecs")
          ? {
              featureSpecs: [
                { featureType: "langPower", namespace: `e${TRAVERSAL}::m1`, parameters: [] },
              ],
            }
          : json,
    ],
    [
      "a microversion",
      (method: string, path: string, json: unknown) =>
        path.endsWith("/featurespecs")
          ? {
              featureSpecs: [
                { featureType: "langPower", sourceMicroversionId: TRAVERSAL, parameters: [] },
              ],
            }
          : json,
    ],
    [
      "a feature id",
      (method: string, path: string, json: unknown) =>
        path.endsWith("/features")
          ? {
              feature: { featureId: `F1")); evil(("${TRAVERSAL}` },
              featureState: { featureStatus: "OK" },
            }
          : json,
    ],
    [
      "an entity id",
      (method: string, path: string, json: unknown) =>
        path.endsWith("/featurescript") && JSON.stringify(json).includes("JHD")
          ? { result: encode([[TRAVERSAL]]) }
          : json,
    ],
  ] as const)(
    "never puts %s that isn't in Onshape's format into a request (19)",
    async (_, tamper) => {
      const onshape = new FakeOnshape();
      onshape.tamper = tamper;
      const dir = directory();
      await record(onshape, dir, [named("corpus-bolt-circle"), named("lang-power")]);
      for (const request of onshape.requests) {
        expect(request.url).not.toContain("..");
        expect(new URL(request.url).href).toBe(request.url);
        for (const match of request.path.matchAll(/\/(d|w|e)\/([^/?]+)/g))
          expect(match[2]).toMatch(/^[0-9a-f]{24}$/);
        expect(JSON.stringify(request.body ?? null)).not.toContain(TRAVERSAL);
        expect(JSON.stringify(request.body ?? null)).not.toContain("evil(");
      }
      expect(written(dir)).not.toContain(TRAVERSAL);
    },
  );

  it("drops a state file whose ids aren't in Onshape's format (19)", async () => {
    const onshape = new FakeOnshape();
    scratch(onshape);
    const dir = directory({
      document: { id: SCRATCH, workspace: TRAVERSAL },
      studios: {
        abc: {
          file: "language.fs",
          elementId: TRAVERSAL,
          namespace: null,
          features: ["langPower"],
          specs: {},
        },
      },
      emptyPartStudio: TRAVERSAL,
    });
    const summary = await record(onshape, dir, [
      named("lang-power"),
      named("context-default-planes"),
    ]);
    expect(summary.recorded).toEqual(["lang-power", "context-default-planes"]);
    for (const request of onshape.requests) expect(request.url).not.toContain("..");
    expect(summary.document).toEqual({ id: SCRATCH, workspace: SCRATCH_WORKSPACE });
  });

  describe("each spelling of an echoed key, alone in a probe value (20)", () => {
    const id = "ABCDEFGHIJKLMNOPQRSTUVWX";
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
    const key = credentials(id, secret);
    const token = key.header().slice("Basic ".length);
    const leaks = leaksOf(id, secret);
    it.each([
      ["the header", `Basic ${token}`],
      ["base64 wrapped at column 76", `${token.slice(0, 76)}\n${token.slice(76)}`],
      ["base64 wrapped with CRLF", `${token.slice(0, 40)}\r\n${token.slice(40)}`],
      [
        "the secret as \\uXXXX escapes",
        Array.from(secret, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
      ],
      [
        "the secret percent-encoded",
        Array.from(secret, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
      ],
      ["the key id", id],
    ] as const)("refuses %s", async (_, echo) => {
      const onshape = new FakeOnshape();
      onshape.probe = () => ({
        status: 200,
        json: {
          result: encode({ statuses: [], bodies: [], variables: {}, values: { echo } }),
          libraryVersion: 3095,
        },
      });
      const dir = directory();
      const summary = await record(onshape, dir, [probeCase("spelling", { echo: "1" })], {
        credentials: key,
      });
      expect(summary.recorded).toEqual([]);
      expect(failures(dir).spelling?.code).toBe("CREDENTIAL_ECHO");
      expect(leaks(written(dir))).toEqual([]);
    });
  });

  it("never writes a response body, or an echo in any spelling, to disk (20)", async () => {
    const id = "ABCDEFGHIJKLMNOPQRSTUVWX";
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
    const key = credentials(id, secret);
    const token = key.header().slice("Basic ".length);
    const wrapped = `${token.slice(0, 76)}\n${token.slice(76)}`;
    const escaped = Array.from(
      secret,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ).join("");
    const percent = Array.from(
      secret,
      (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
    ).join("");
    const leaks = leaksOf(id, secret);
    const echoes = probeCase("echoes", { wrapped: "1", escaped: "1", percent: "1" });

    const onshape = new FakeOnshape();
    onshape.probe = () => ({
      status: 200,
      json: {
        result: encode({
          statuses: [],
          bodies: [],
          variables: { wrapped },
          values: { wrapped, escaped, percent },
        }),
        libraryVersion: 3095,
        notices: [{ message: wrapped }],
      },
    });
    onshape.specs = () => ({
      status: 200,
      json: {
        featureSpecs: ["plate", "boltCircle", "langPower"].map((featureType) => ({
          featureType,
          parameters: [{ parameterId: "x", btType: "Q", defaultValue: { expression: escaped } }],
        })),
      },
    });
    onshape.queries = () => ({ status: 500, json: { message: percent, wrapped } });
    const lines: string[] = [];
    const dir = directory();
    const summary = await record(
      onshape,
      dir,
      [echoes, named("lang-power"), named("corpus-bolt-circle")],
      {
        credentials: key,
        log: (line) => lines.push(line),
      },
    );
    expect(summary.recorded).toEqual([]);
    // Each response holds an echo, so each is refused as it arrives, before the case reads it.
    expect(failures(dir)).toMatchObject({
      echoes: { code: "CREDENTIAL_ECHO" },
      "lang-power": { code: "CREDENTIAL_ECHO" },
      "corpus-bolt-circle": { code: "CREDENTIAL_ECHO" },
    });
    for (const text of [written(dir), lines.join("\n"), JSON.stringify(summary)])
      expect(leaks(text)).toEqual([]);
    expect(NodeFS.existsSync(new URL("raw/", dir))).toBe(false);

    // A failure keeps fixed fields only: a code and where, never the body.
    const plain = new FakeOnshape();
    plain.queries = () => ({ status: 500, json: { message: "this body must not be kept" } });
    plain.probe = () => ({ status: 500, json: { message: "nor this one" } });
    const plainDir = directory();
    await record(plain, plainDir, [named("corpus-bolt-circle"), named("lang-power")]);
    expect(written(plainDir)).not.toMatch(/must not be kept|nor this one/);
    // Nor does a run that stops: on a quota error, or a search it can't read.
    const quota = new FakeOnshape();
    quota.quotaAfter = 0;
    quota.quotaReply = { message: "quota body must not be kept" };
    const search = new FakeOnshape();
    search.search = () => ({ status: 200, json: { message: "search body must not be kept" } });
    for (const onshape of [quota, search]) {
      const lines: string[] = [];
      const stoppedDir = directory();
      const stopped = await record(onshape, stoppedDir, [named("lang-power")], {
        log: (line) => lines.push(line),
      });
      expect(stopped.stopped).toBeTruthy();
      expect(`${JSON.stringify(stopped)}\n${lines.join("\n")}\n${written(stoppedDir)}`).not.toMatch(
        /must not be kept/,
      );
    }
    for (const failure of Object.values(failures(plainDir)))
      expect(Object.keys(failure).sort()).toEqual(
        expect.arrayContaining(["code", "failedAt", "hash"]),
      );
  });

  it.each([
    [
      "a solid without its volume",
      { values: { expected: 1 }, bodies: [{ ...solid, volume: undefined }] },
    ],
    [
      "a solid whose measure failed",
      { values: { expected: 1 }, bodies: [{ ...solid, volume: undefined, measure: "<error>" }] },
    ],
    [
      "a sheet without its area",
      { values: { expected: 1 }, bodies: [{ ...solid, types: ["SHEET"], volume: undefined }] },
    ],
    [
      "a wire without its length",
      { values: { expected: 1 }, bodies: [{ ...solid, types: ["WIRE"], volume: undefined }] },
    ],
    [
      "a solid whose box failed",
      { values: { expected: 1 }, bodies: [{ ...solid, box: "<error>" }] },
    ],
    ["a body with no type", { values: { expected: 1 }, bodies: [{ ...solid, types: [] }] }],
    ["no requested value", { values: {}, bodies: [] }],
    ["an extra value", { values: { expected: 1, extra: 2 }, bodies: [] }],
  ] as const)("leaves a case pending when its probe has %s (21)", async (_, probe) => {
    const onshape = new FakeOnshape();
    const result = { statuses: [], variables: {}, ...probe };
    onshape.probe = () => ({
      status: 200,
      json: { result: encode(JSON.parse(JSON.stringify(result))), libraryVersion: 3095 },
    });
    const dir = directory();
    const asking = probeCase("asking", { expected: "123" });
    await record(onshape, dir, [asking]);
    expect(readRecording(asking, dir)).toBeNull();
    expect(failures(dir).asking?.code).toBe("PROBE_SCHEMA");
  });

  it("records a probe whose bodies carry their measurements and whose values are all there (21)", async () => {
    const onshape = new FakeOnshape();
    const point = {
      types: ["POINT", "MATE_CONNECTOR"],
      sketch: false,
      construction: false,
      faces: 0,
      edges: 0,
      vertices: 1,
      box: "<error>",
    };
    onshape.probe = () => ({
      status: 200,
      json: {
        // JSON drops the sheet's undefined volume.
        result: encode(
          JSON.parse(
            JSON.stringify({
              statuses: [],
              variables: {},
              values: { expected: "<undefined>" },
              bodies: [solid, { ...solid, types: ["SHEET"], volume: undefined, area: 2 }, point],
            }),
          ),
        ),
        libraryVersion: 3095,
      },
    });
    const dir = directory();
    const asking = probeCase("asking", { expected: "123" });
    const summary = await record(onshape, dir, [asking]);
    expect(summary.recorded).toEqual(["asking"]);
    expect(readRecording(asking, dir)?.probe?.result.values).toEqual({ expected: "<undefined>" });
  });

  it.each([
    ["a value", { values: { big: { btType: "BTFSValueTooBig-1247" } }, variables: {} }],
    ["a variable", { values: { big: 1 }, variables: { big: { btType: "BTFSValueTooBig-1247" } } }],
  ])("leaves a case pending when Onshape withholds %s as too big (23)", async (_, parts) => {
    const onshape = new FakeOnshape();
    const plainMap = (entries: Record<string, unknown>) => ({
      btType: "BTFSValueMap-2062",
      value: Object.entries(entries).map(([key, value]) => ({
        key: encode(key),
        value: typeof value === "number" ? encode(value) : value,
      })),
    });
    onshape.probe = () => ({
      status: 200,
      json: {
        result: plainMap({
          statuses: encode([]),
          bodies: encode([]),
          variables: plainMap(parts.variables),
          values: plainMap(parts.values),
        }),
        libraryVersion: 3095,
      },
    });
    const dir = directory();
    const tooBig = probeCase("too-big", { big: "[0, 1, 2]" });
    const summary = await record(onshape, dir, [tooBig]);
    expect(summary.recorded).toEqual([]);
    expect(failures(dir)["too-big"]?.code).toBe("PROBE_SCHEMA");
    expect(pendingCases([tooBig], dir)).toEqual([tooBig]);
  });

  it("creates the Part Studio for cases without features again when the remembered one is gone (24)", async () => {
    const onshape = new FakeOnshape();
    scratch(onshape);
    const gone = hexId("gone");
    const dir = directory({
      document: { id: SCRATCH, workspace: SCRATCH_WORKSPACE },
      studios: {},
      emptyPartStudio: gone,
    });
    const featureless = named("context-default-planes");
    const summary = await record(onshape, dir, [featureless, probeCase("featureless")]);
    expect(summary.recorded).toEqual([featureless.name, "featureless"]);
    const state = JSON.parse(NodeFS.readFileSync(new URL("onshape.json", dir), "utf8"));
    expect(state.emptyPartStudio).not.toBe(gone);
    expect(state.emptyPartStudio).toMatch(/^[0-9a-f]{24}$/);
    // One new Part Studio, made in the scratch document, then reused.
    expect(posts(onshape, `/partstudios/d/${SCRATCH}/w/${SCRATCH_WORKSPACE}`)).toHaveLength(1);
    expect(readRecording(featureless, dir)?.partStudio).toContain(state.emptyPartStudio);
  });

  it("creates a Feature Studio again when the remembered one is gone, once per run (24)", async () => {
    const onshape = new FakeOnshape();
    const dir = directory();
    const lines: string[] = [];
    expect((await record(onshape, dir, [named("lang-power")])).recorded).toEqual(["lang-power"]);
    const studiosOf = () =>
      Object.values(
        JSON.parse(NodeFS.readFileSync(new URL("onshape.json", dir), "utf8")).studios,
      ) as {
        readonly elementId: string;
      }[];
    const [first] = studiosOf();
    onshape.deleteElement(first!.elementId);

    const creates = () =>
      onshape.requests.filter(
        (request) =>
          request.method === "POST" && /^\/featurestudios\/d\/\w+\/w\/\w+$/.test(request.path),
      ).length;
    const before = creates();
    const summary = await record(onshape, dir, [named("lang-tilde"), named("lang-tostring")], {
      log: (line) => lines.push(line),
    });
    expect(summary.recorded).toEqual(["lang-tilde", "lang-tostring"]);
    expect(creates() - before).toBe(1);
    expect(lines.filter((line) => line.startsWith("STATE_STALE"))).toHaveLength(1);
    const [second] = studiosOf();
    expect(second!.elementId).not.toBe(first!.elementId);

    // A 404 from the new one too fails the cases that need it, without making a third.
    onshape.deleteElement(second!.elementId);
    onshape.specs = () => ({ status: 404, json: {} });
    const again = creates();
    const failing = await record(
      onshape,
      dir,
      [named("lang-power"), named("lang-nullish-precedence")].map((c) => ({
        ...c,
        name: `${c.name}-again`,
        description: "again",
      })),
    );
    expect(failing.recorded).toEqual([]);
    expect(
      Object.values(failures(dir)).filter((failure) => failure.code === "SPECS_INVALID"),
    ).toHaveLength(2);
    expect(creates() - again).toBe(1);
  });

  describe("a response that holds the key is refused as it arrives (25)", () => {
    const id = "ABCDEFGHIJKLMNOPQRSTUVWX";
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
    const key = credentials(id, secret);
    const token = key.header().slice("Basic ".length);
    const spellings = [
      ["the header", `Basic ${token}`],
      ["base64 wrapped with LF", `${token.slice(0, 76)}\n${token.slice(76)}`],
      ["base64 wrapped with CRLF", `${token.slice(0, 40)}\r\n${token.slice(40)}`],
      [
        "the secret as \\uXXXX",
        Array.from(secret, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
      ],
      [
        "the secret as %XX",
        Array.from(secret, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
      ],
      ["the key id", id],
    ] as const;
    /** A probe result whose values map has the echo as a key that isn't a string: a list of it. */
    const listKeyed = (echo: string) => ({
      btType: "BTFSValueMap-2062",
      value: [
        { key: encode("statuses"), value: encode([]) },
        { key: encode("bodies"), value: encode([]) },
        { key: encode("variables"), value: encode({}) },
        {
          key: encode("values"),
          value: {
            btType: "BTFSValueMap-2062",
            value: [{ key: encode([echo]), value: encode(1) }],
          },
        },
      ],
    });
    const positions = [
      [
        "a map key that isn't a string",
        (echo: string) => ({
          status: 200,
          json: { result: listKeyed(echo), libraryVersion: 3095 },
        }),
      ],
      [
        "a nested key",
        (echo: string) => ({
          status: 200,
          json: { result: encode(1), meta: { nested: { [echo]: 1 } } },
        }),
      ],
      [
        "an error payload",
        (echo: string) => ({ status: 500, json: { message: "failed", detail: [echo] } }),
      ],
    ] as const;
    const cases = spellings.flatMap(([spelling, echo]) =>
      positions.map(([position, reply]) => [`${spelling} in ${position}`, echo, reply] as const),
    );

    it.each(cases)("refuses %s at the client", async (_, echo, reply) => {
      const { status, json } = reply(echo);
      const client = new OnshapeClient(
        async () => new Response(JSON.stringify(json), { status }),
        key,
      );
      await expect(client.send("POST", "/x", S.unknown)).rejects.toBeInstanceOf(
        CredentialEchoError,
      );
    });

    it.each(cases)("records nothing for %s", async (_, echo, reply) => {
      const onshape = new FakeOnshape();
      onshape.probe = () => reply(echo);
      const dir = directory();
      const summary = await record(onshape, dir, [probeCase("echo")], { credentials: key });
      expect(summary.recorded).toEqual([]);
      expect(failures(dir).echo?.code).toBe("CREDENTIAL_ECHO");
      expect(leaksOf(id, secret)(written(dir))).toEqual([]);
    });
  });

  describe("a crash report never prints a frame an error forges (26)", () => {
    // Long enough that the base64 token (100 characters) wraps at column 76.
    const id = "ABCDEFGHIJKLMNOPQRSTUVWX";
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
    const key = credentials(id, secret);
    const token = key.header().slice("Basic ".length);
    const shown = (report: string) => [
      ...leaksOf(id, secret)(report),
      ...fragmentsOf(token).filter((piece) => report.includes(piece)),
    ];
    it.each([
      ["LF", "\n"],
      ["CRLF", "\r\n"],
    ] as const)(
      "with %s wrapping, in the name of an error with an empty message or the same message",
      (_, separator) => {
        const wrapped = `${token.slice(0, 76)}${separator}${token.slice(76)}`;
        for (const error of [
          Object.assign(new Error(""), { name: `N\n    at ${wrapped}` }),
          Object.assign(new Error("boom"), { name: `boom\n    at ${wrapped}` }),
          new Error(`late\n    at ${wrapped}`),
          Object.assign(new Error("late"), {
            cause: Object.assign(new Error(""), { name: `C\n    at ${wrapped}` }),
          }),
        ]) {
          const report = describeThrown(error, key);
          expect(shown(report)).toEqual([]);
          expect(report).toMatch(/withheld/);
        }
      },
    );

    it("reports an error whose name or message isn't a string, instead of crashing on it", () => {
      for (const [field, value] of [
        ["name", { toString: () => "x" }],
        ["name", 7],
        ["name", Symbol("s")],
        ["message", { toString: () => "x" }],
      ] as const) {
        const error = new Error("late");
        Object.defineProperty(error, field, { value });
        const report = describeThrown(error, key);
        expect(report).not.toMatch(/is not a function/);
        expect(report).toContain(`<${typeof value}>`);
      }
      const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-name-"));
      const keyFile = NodePath.join(scratchDir, "key.json");
      NodeFS.writeFileSync(keyFile, JSON.stringify({ accessKeyId: id, secretKey: secret }));
      const preload = NodePath.join(scratchDir, "preload.mjs");
      NodeFS.writeFileSync(
        preload,
        "globalThis.fetch = (url, init) => { const e = new Error('late'); e.name = { toString: () => 'x' }; Promise.reject(e); return new Promise(() => {}); };",
      );
      const cli = NodeURL.fileURLToPath(new URL("../conformance/record.ts", import.meta.url));
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          cli,
          "--case",
          "lang-power",
          "--recordings",
          NodePath.join(scratchDir, "recordings"),
        ],
        { encoding: "utf8", env: { ...process.env, ONSHAPE_KEY_FILE: keyFile } },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/^Unexpected <object>: late/m);
      expect(result.stderr).not.toMatch(/is not a function/);
    });

    it("shows a thrown value or cause that isn't an Error as its type, never inspected", () => {
      const wrapped = `${token.slice(0, 76)}\n${token.slice(76)}`;
      const crlf = `${token.slice(0, 76)}\r\n${token.slice(76)}`;
      const escaped = Array.from(
        secret,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ).join("");
      for (const [thrown, type] of [
        [{ token: wrapped }, "object"],
        [[crlf], "object"],
        [Object.assign(new Error("late"), { cause: { secret: escaped } }), "object"],
        [Object.assign(new Error("late"), { cause: [wrapped] }), "object"],
        [7, "number"],
      ] as const) {
        const report = describeThrown(thrown, key);
        expect(shown(report)).toEqual([]);
        expect(report).toContain(`<${type}>`);
        expect(report).not.toMatch(/token|secret:/);
      }
      // A thrown string is checked as it is, with its real newline.
      expect(describeThrown(wrapped, key)).toMatch(/withheld/);
      expect(describeThrown("plain words", key)).toBe("string: plain words");
    });

    it("prints no part of a thrown object or cause through the command line", () => {
      const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-object-"));
      const keyFile = NodePath.join(scratchDir, "key.json");
      NodeFS.writeFileSync(keyFile, JSON.stringify({ accessKeyId: id, secretKey: secret }));
      const cli = NodeURL.fileURLToPath(new URL("../conformance/record.ts", import.meta.url));
      for (const [i, body] of [
        "Promise.reject({ token: h.slice(0, 76) + '\\n' + h.slice(76) });",
        "Promise.reject(Object.assign(new Error('late'), { cause: { secret: Array.from(s, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') } }));",
      ].entries()) {
        const preload = NodePath.join(scratchDir, `preload-${i}.mjs`);
        NodeFS.writeFileSync(
          preload,
          `globalThis.fetch = (url, init) => { const h = init.headers.Authorization.slice(6); const s = Buffer.from(h, 'base64').toString().split(':')[1]; ${body} return new Promise(() => {}); };`,
        );
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [
            "--import",
            preload,
            cli,
            "--case",
            "lang-power",
            "--recordings",
            NodePath.join(scratchDir, `recordings-${i}`),
          ],
          { encoding: "utf8", env: { ...process.env, ONSHAPE_KEY_FILE: keyFile } },
        );
        expect(result.status).toBe(1);
        expect(shown(`${result.stdout}\n${result.stderr}`)).toEqual([]);
        expect(result.stderr).toMatch(/^Unexpected /m);
      }
    });

    /** Errors whose reading throws an error that carries the header. */
    const hostile = (header: string): unknown[] => {
      const throwing = (field: string) => {
        const error = new Error("late");
        Object.defineProperty(error, field, {
          get() {
            throw new Error(`getter ${header}`);
          },
        });
        return error;
      };
      return [
        throwing("name"),
        throwing("message"),
        throwing("cause"),
        throwing("stack"),
        new Proxy(new Error("late"), {
          getPrototypeOf() {
            throw new Error(`proxy ${header}`);
          },
        }),
      ];
    };

    it("never throws while describing an error whose reading throws (with the key in it)", () => {
      for (const thrown of hostile(key.header())) {
        let report = "";
        expect(() => (report = describeThrown(thrown, key))).not.toThrow();
        expect(shown(report)).toEqual([]);
      }
    });

    it("prints a report, not Node's, when reading the error throws through the command line", () => {
      const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-getter-"));
      const keyFile = NodePath.join(scratchDir, "key.json");
      NodeFS.writeFileSync(keyFile, JSON.stringify({ accessKeyId: id, secretKey: secret }));
      const cli = NodeURL.fileURLToPath(new URL("../conformance/record.ts", import.meta.url));
      const build =
        "const e = new Error('late'); Object.defineProperty(e, FIELD, { get() { throw new Error('getter ' + init.headers.Authorization); } });";
      let i = 0;
      for (const field of ["name", "message", "cause", "stack"])
        for (const raise of ["setTimeout(() => { throw e; });", "Promise.reject(e);"]) {
          const preload = NodePath.join(scratchDir, `preload-${(i += 1)}.mjs`);
          NodeFS.writeFileSync(
            preload,
            `globalThis.fetch = (url, init) => { ${build.replace("FIELD", JSON.stringify(field))} ${raise} return new Promise(() => {}); };`,
          );
          const result = NodeChildProcess.spawnSync(
            process.execPath,
            [
              "--import",
              preload,
              cli,
              "--case",
              "lang-power",
              "--recordings",
              NodePath.join(scratchDir, `recordings-${i}`),
            ],
            { encoding: "utf8", env: { ...process.env, ONSHAPE_KEY_FILE: keyFile } },
          );
          expect([field, raise, result.status]).toEqual([field, raise, 1]);
          expect(shown(`${result.stdout}\n${result.stderr}`)).toEqual([]);
          expect(result.stderr).toMatch(/^Unexpected /m);
        }
    });

    it("prints a warning whose name isn't a string, or can't be read, through the same printer", () => {
      // Node's emitWarning reads a warning's name itself, so one whose name getter throws never
      // reaches a listener; the printer still has to handle it if one does.
      const unreadable = new Error("w");
      Object.defineProperty(unreadable, "name", {
        get() {
          throw new Error(`getter ${key.header()}`);
        },
      });
      expect(describeThrown(unreadable, key, { frames: false })).toBe("<unreadable>: w");

      const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-warning-"));
      const keyFile = NodePath.join(scratchDir, "key.json");
      NodeFS.writeFileSync(keyFile, JSON.stringify({ accessKeyId: id, secretKey: secret }));
      const preload = NodePath.join(scratchDir, "preload.mjs");
      NodeFS.writeFileSync(
        preload,
        "globalThis.fetch = async (url, init) => { const w = new Error('w'); w.name = { toString: () => 'x' }; process.emitWarning(w); await new Promise((resolve) => setImmediate(resolve)); throw new Error('transport failure'); };",
      );
      const cli = NodeURL.fileURLToPath(new URL("../conformance/record.ts", import.meta.url));
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          cli,
          "--case",
          "lang-power",
          "--recordings",
          NodePath.join(scratchDir, "recordings"),
        ],
        { encoding: "utf8", env: { ...process.env, ONSHAPE_KEY_FILE: keyFile } },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/TRANSPORT_FAILED/);
      expect(result.stderr).toMatch(/^<object>: w$/m);
      expect(result.stderr).not.toMatch(/^Unexpected/m);
      expect(shown(`${result.stdout}\n${result.stderr}`)).toEqual([]);
    });

    it("may print a frame-shaped line left by a message changed after its stack, but still checks it", () => {
      // The frames are read after the header the error has now; text from the old message stays.
      const changed = new Error("boom\n    at file:///forged.js:1:1");
      void changed.stack;
      changed.message = "boom";
      expect(describeThrown(changed, key)).toContain("    at file:///forged.js:1:1");
      const keyed = new Error(`boom\n    at file:///${id}.js:1:1`);
      void keyed.stack;
      keyed.message = "boom";
      expect(describeThrown(keyed, key)).toMatch(/withheld/);
      expect(shown(describeThrown(keyed, key))).toEqual([]);
    });

    it("keeps the real frames of an error that holds nothing secret", () => {
      const report = describeThrown(new Error("plain failure"), key);
      expect(report).toMatch(/^Error: plain failure\n {4}at /);
      for (const line of report.split("\n").slice(1))
        expect(line).toMatch(/^ {4}at .*(file:\/\/\/|node:)[^ ]*:\d+:\d+\)?$/);
    });

    it("prints none of it through the command line", () => {
      const scratchDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conformance-forged-"));
      const keyFile = NodePath.join(scratchDir, "key.json");
      NodeFS.writeFileSync(keyFile, JSON.stringify({ accessKeyId: id, secretKey: secret }));
      const preload = NodePath.join(scratchDir, "preload.mjs");
      NodeFS.writeFileSync(
        preload,
        "globalThis.fetch = (url, init) => { const h = init.headers.Authorization.slice(6); Promise.reject(Object.assign(new Error(''), { name: 'N\\n    at ' + h.slice(0, 76) + '\\n' + h.slice(76) })); return new Promise(() => {}); };",
      );
      const cli = NodeURL.fileURLToPath(new URL("../conformance/record.ts", import.meta.url));
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          cli,
          "--case",
          "lang-power",
          "--recordings",
          NodePath.join(scratchDir, "recordings"),
        ],
        { encoding: "utf8", env: { ...process.env, ONSHAPE_KEY_FILE: keyFile } },
      );
      expect(result.status).not.toBe(0);
      expect(shown(`${result.stdout}\n${result.stderr}`)).toEqual([]);
      expect(result.stderr).toMatch(/withheld/);
    });
  });

  it.each([
    ["now lists no features", () => ({ featureSpecs: [] })],
    [
      "now has other inputs",
      (path: string) => ({
        featureSpecs: ["langPower", "langTilde", "langToString"].map((featureType) => ({
          featureType,
          namespace: `e${/\/e\/(\w+)\//.exec(path)![1]}::m${hexId("mv")}`,
          parameters: [{ parameterId: "edited" }],
        })),
      }),
    ],
  ] as const)(
    "creates a Feature Studio again when the remembered one %s (24)",
    async (_, changed) => {
      const onshape = new FakeOnshape();
      const dir = directory();
      expect((await record(onshape, dir, [named("lang-power")])).recorded).toEqual(["lang-power"]);
      const studioOf = () =>
        (
          Object.values(
            JSON.parse(NodeFS.readFileSync(new URL("onshape.json", dir), "utf8")).studios,
          ) as {
            readonly elementId: string;
            readonly namespace: string;
          }[]
        )[0]!;
      const old = studioOf();
      onshape.specs = (path) =>
        path.includes(old.elementId) ? { status: 200, json: changed(path) } : undefined;
      const lines: string[] = [];
      const summary = await record(onshape, dir, [named("lang-tilde")], {
        log: (line) => lines.push(line),
      });
      expect(summary.recorded).toEqual(["lang-tilde"]);
      expect(lines.filter((line) => line.startsWith("STATE_STALE"))).toHaveLength(1);
      const fresh = studioOf();
      expect(fresh.elementId).not.toBe(old.elementId);
      const recording = readRecording(named("lang-tilde"), dir)!;
      expect(recording.sources[0]).toMatchObject({
        compiled: true,
        specs: { langTilde: { parameters: [] } },
      });
      const added = onshape.requests.findLast((request) => request.path.endsWith("/features"));
      expect((added!.body as { feature: { namespace: string } }).feature.namespace).toBe(
        fresh.namespace,
      );
    },
  );

  it.each([
    ["is refused", { status: 403, json: {} }, /HTTP_ERROR.*403/],
    ["comes back malformed", { status: 200, json: { id: "not an id" } }, /RESPONSE_SCHEMA/],
  ] as const)(
    "stops the run when making a Part Studio %s, for a featureless case's retry as for any case (24)",
    async (_, reply, stop) => {
      const creates = (method: string, path: string) =>
        method === "POST" && /^\/partstudios\/d\/\w+\/w\/\w+$/.test(path) ? reply : undefined;

      const featured = new FakeOnshape();
      featured.intercept = creates;
      const featuredDir = directory();
      const featuredRun = await record(featured, featuredDir, [named("lang-power")]);
      expect(featuredRun.stopped).toMatch(stop);

      const featureless = new FakeOnshape();
      scratch(featureless);
      featureless.intercept = creates;
      const dir = directory({
        document: { id: SCRATCH, workspace: SCRATCH_WORKSPACE },
        studios: {},
        emptyPartStudio: hexId("gone"),
      });
      const run = await record(featureless, dir, [probeCase("featureless"), probeCase("after")]);
      expect(run.stopped).toMatch(stop);
      expect(run.failed).toEqual({});
      // The run stopped there: the next case never ran.
      expect(
        featureless.requests.filter((request) => request.path.endsWith("/featurescript")),
      ).toHaveLength(1);
    },
  );

  describe("a deeply nested response (27)", () => {
    const id = "ABCDEFGHIJKLMNOPQRSTUVWX";
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
    const key = credentials(id, secret);
    /** `inner` inside `depth` lists. */
    const nested = (depth: number, inner: unknown): unknown => {
      let value = inner;
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };

    it("is checked for the key without overflowing", () => {
      expect(key.exposedInValue(nested(10_000, id))).toBe(true);
      expect(key.exposedInValue(nested(10_000, { [secret]: 1 }))).toBe(true);
      expect(key.exposedInValue(nested(10_000, "nothing"))).toBe(false);
    });

    it("is refused at the client with a coded error, or as an echo when it holds the key", async () => {
      const client = (text: string) =>
        new OnshapeClient(async () => new Response(text, { status: 200 }), key).send(
          "GET",
          "/x",
          S.unknown,
        );
      const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
      const refused = await client(deep).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ResponseError);
      expect((refused as ResponseError).message).toMatch(/RESPONSE_SCHEMA.*levels/);
      // Written as text: JSON.stringify itself overflows on this.
      const deepWithKey = `${"[".repeat(10_000)}${JSON.stringify(id)}${"]".repeat(10_000)}`;
      await expect(client(deepWithKey)).rejects.toBeInstanceOf(CredentialEchoError);
      // Real responses are nowhere near the limit.
      await expect(client(JSON.stringify(nested(200, 1)))).resolves.toBeDefined();
    });

    it("fails the case, not the run, as a probe", async () => {
      const onshape = new FakeOnshape();
      // Deep past the limit, yet shallow enough for the fake to serialize.
      onshape.probe = () => ({
        status: 200,
        json: { result: nested(1_000, 1), libraryVersion: 3095 },
      });
      const dir = directory();
      const summary = await record(onshape, dir, [probeCase("deep"), named("lang-power")]);
      expect(summary.stopped).toBeNull();
      expect(failures(dir).deep?.code).toBe("PROBE_RESPONSE");
    });
  });

  it("treats a recording made before its case changed as stale, and records it again (22)", async () => {
    const onshape = new FakeOnshape();
    const dir = directory();
    const first = probeCase("edited", { a: "1" });
    expect((await record(onshape, dir, [first])).recorded).toEqual(["edited"]);
    const edited = probeCase("edited", { a: "1", b: "2" });
    expect(loadRecording(edited, dir)).toMatchObject({ kind: "stale" });
    expect(readRecording(edited, dir)).toBeNull();
    expect(pendingCases([edited], dir)).toEqual([edited]);
    expect((await record(onshape, dir, [edited])).recorded).toEqual(["edited"]);
    expect(loadRecording(edited, dir)).toMatchObject({ kind: "current" });

    // A stale file isn't decoded past its hash, so one the current schema would refuse still loads as stale.
    const file = new URL("edited.json", dir);
    const recording = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    NodeFS.writeFileSync(
      file,
      JSON.stringify({ ...recording, hash: "older", probe: { result: { bodies: [7] } } }),
    );
    expect(loadRecording(edited, dir)).toEqual({ kind: "stale", recordedAt: recording.recordedAt });

    // The command line's dry run lists it instead of crashing.
    const cli = NodeURL.fileURLToPath(new URL("../conformance/record.ts", import.meta.url));
    const recordings = NodeURL.fileURLToPath(dir);
    const throughAll = named("confirm-through-all");
    NodeFS.writeFileSync(
      NodePath.join(recordings, `${throughAll.name}.json`),
      JSON.stringify({
        ...recording,
        case: throughAll.name,
        hash: "older",
        probe: { result: { values: {} } },
      }),
    );
    const dryRun = NodeChildProcess.spawnSync(
      process.execPath,
      [cli, "--case", throughAll.name, "--dry-run", "--recordings", recordings],
      { encoding: "utf8" },
    );
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain(throughAll.name);
  });

  it("records a source Onshape doesn't compile, without a Part Studio (7)", async () => {
    const onshape = new FakeOnshape();
    onshape.compiles = (source) => !source.includes("3, ]");
    const dir = directory();
    await record(onshape, dir, [named("lang-trailing-comma-array")]);
    const recording = readRecording(named("lang-trailing-comma-array"), dir);
    expect(recording).toMatchObject({
      sources: [{ file: "trailing-comma-array.fs", compiled: false }],
      probe: null,
    });
    expect(
      onshape.requests.some((request) => /^\/partstudios\/d\/\w+\/w\/\w+$/.test(request.path)),
    ).toBe(false);
  });
});

describe("case hashes", () => {
  // A recording depends only on what's sent to Onshape: rewording a case's description or covers,
  // or changing how its values are compared, must not make its recording stale (each re-record
  // costs API calls), while changing a probe value must.
  it("change with what's recorded, not with a case's prose or comparison settings", () => {
    const lang = named("lang-power");
    const hash = caseHash(lang);
    expect(
      caseHash({
        ...lang,
        description: `${lang.description} Reworded.`,
        covers: `${lang.covers}, more`,
        area: "evaluators/queries",
        areas: { anything: "evaluators/queries" },
        tolerances: { anything: { relative: 1, absolute: 1 } },
      }),
    ).toBe(hash);
    expect(caseHash({ ...lang, values: { ...lang.values, extra: "1 + 1" } })).not.toBe(hash);
  });
});

describe("probe statuses", () => {
  it("leaves a case pending when its probe misses a feature's status (11)", async () => {
    const onshape = new FakeOnshape();
    onshape.probe = (script: string) => ({
      status: 200,
      json: {
        result: encode({
          statuses: [],
          bodies: [],
          variables: {},
          values: Object.fromEntries(requestedValues(script).map((name) => [name, 0])),
        }),
        libraryVersion: 3095,
        notices: [],
      },
    });
    const dir = directory();
    const lang = named("lang-power");
    expect(lang.features.length).toBeGreaterThan(0);
    await record(onshape, dir, [lang]);
    expect(readRecording(lang, dir)).toBeNull();
    expect(failures(dir)["lang-power"]?.code).toBe("PROBE_SCHEMA");
  });
});

describe("damaged files", () => {
  // A crash while writing left truncated JSON; the next run must resume, not stop before asking.
  it("resumes past a truncated recording, state and failures file", async () => {
    const onshape = new FakeOnshape();
    const dir = directory();
    const lang = named("lang-power");
    for (const file of [`${lang.name}.json`, "onshape.json", "failures.json"])
      NodeFS.writeFileSync(new URL(file, dir), '{"hash": "');
    await record(onshape, dir, [lang]);
    expect(onshape.requests.length).toBeGreaterThan(0);
    expect(readRecording(lang, dir)?.hash).toBe(caseHash(lang));
  });
});
