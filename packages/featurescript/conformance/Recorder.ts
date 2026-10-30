// @effect-diagnostics nodeBuiltinImport:off - reads case sources and writes recordings to disk.
// @effect-diagnostics globalDate:off - recordings carry the time they were made.
// @effect-diagnostics globalTimers:off - waits once before re-reading a Feature Studio's specs.
/**
 * Records conformance cases in real Onshape; `record.ts` is its command line, and
 * `test/conformance.record.test.ts` runs it against a fake Onshape.
 *
 * Everything goes into one document, "Cadsense conformance (scratch)", which the key's user
 * created and owns. It's found by name (or created, privately) on the first run and remembered in
 * `onshape.json`; every run checks the remembered ids against that name and owner before writing
 * anything, and looks the document up again if they don't match. The search reads every page, and
 * checks every same-named result in full (looking it up if the listing is partial), before creating
 * anything; a listing it can't read stops the run. Nothing else is written, shared or deleted.
 *
 * Every response is checked for the key as received and decoded through a schema in
 * `OnshapeApi.ts`; every id in a request is in Onshape's format; nothing a response says is kept
 * beyond the decoded fields the comparison needs, and failures are fixed codes and positions.
 * Every write is checked for the key again ({@link Credentials.exposedInValue}), and everything
 * logged or returned goes through {@link Credentials.safe}. A response that holds the key fails the
 * case when it's a case's own read (a query, a probe, a studio's specs) and stops the run otherwise.
 *
 * Only cases without a current recording are recorded (see `caseHash`). Each source file becomes one
 * Feature Studio, reused while its content is unchanged and Onshape still has it (checked once a
 * run; a deleted one is made again). Each case gets a new Part Studio: its
 * features are added with the case's inputs (query inputs as the entities Onshape resolves them
 * to), then the probe script reads statuses, bodies, variables and values through the Part Studio
 * FeatureScript endpoint. A case whose queries don't resolve, or whose specs or probe don't decode
 * or are incomplete, isn't recorded: it goes to `failures.json` and stays pending. HTTP 402 or 429
 * stops the run.
 */
import * as NodeFS from "node:fs";
import {
  caseHash,
  onshapeProbe,
  loadRecording,
  probeSchemaFor,
  readSource,
  sourceHash,
  specInputSchema,
  withFeatureIds,
  type CaseFeature,
  type ConformanceCase,
  type FeatureRecord,
  type Parameter,
  type ProbeResult,
  type Recording,
  type SourceRecord,
  type SpecInput,
} from "./Case.ts";
import {
  CredentialEchoError,
  documentInfo,
  documentListing,
  elementCreated,
  entityId,
  evaluation,
  featureAdded,
  featureSpecs,
  HOST,
  namespace,
  OnshapeClient,
  QuotaError,
  ResponseError,
  route,
  sessionInfo,
  TransportError,
  type DocumentInfo,
  type FeatureSpecList,
  type SpecParameter,
} from "./OnshapeApi.ts";
import { onshapeValue } from "./Plain.ts";
import { describeThrown, type Credentials } from "./Redaction.ts";
import * as S from "./Schema.ts";

export const DOCUMENT_NAME = "Cadsense conformance (scratch)";

export interface RecorderOptions {
  /** Sends one request: `fetch` from the command line, a fake in tests. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly credentials: Credentials;
  /** Where recordings go, with the state (`onshape.json`) and `failures.json`. */
  readonly dir: URL;
  /** How long to wait before reading an empty Feature Studio's specs again. Defaults to 3 s. */
  readonly retryDelayMs?: number;
  readonly log?: (line: string) => void;
}

export interface ScratchDocument {
  readonly id: string;
  readonly workspace: string;
}

export interface RecordSummary {
  readonly calls: number;
  readonly recorded: readonly string[];
  /** Cases that failed and stay pending, with their failure code and position. */
  readonly failed: Readonly<Record<string, string>>;
  /** Why the run stopped early: a quota error, a failed request or an unexpected response. */
  readonly stopped: string | null;
  readonly document: ScratchDocument | null;
}

/** What the recorder remembers between runs: the scratch document and the Feature Studios in it. */
const stateSchema = S.object({
  document: S.nullable(S.object({ id: S.hexId, workspace: S.hexId })),
  /** By source hash. */
  studios: S.record(
    S.object({
      file: S.string(),
      elementId: S.hexId,
      namespace: S.nullable(namespace),
      /** Feature types Onshape has a spec for; empty when the studio doesn't compile. */
      features: S.array(S.identifier),
      /** Each feature's dialog input ids. */
      specs: S.record(S.array(specInputSchema)),
    }),
  ),
  /** An empty Part Studio for cases without features. */
  emptyPartStudio: S.nullable(S.hexId),
});
type StudioState = S.Infer<typeof stateSchema>["studios"][string];
/** The state as the recorder updates it during a run. */
interface State {
  document: ScratchDocument | null;
  studios: Record<string, StudioState>;
  emptyPartStudio: string | null;
}
const emptyState = (): State => ({ document: null, studios: {}, emptyPartStudio: null });

/** A state of things the recorder won't go on from, such as a search it can't finish. Stops the run. */
class StopRun extends Error {}

/**
 * A case that can't be recorded faithfully; it stays pending and the run goes on. Its `code` is
 * fixed and its `details` are safe: names from the case, statuses, and schema positions.
 */
class CaseFailure extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, string | number>>;
  /** The HTTP status behind it, when a response failed. */
  readonly status: number | null;
  constructor(
    code: string,
    details: Readonly<Record<string, string | number>> = {},
    status: number | null = null,
  ) {
    const text = Object.entries(details)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ");
    super(text ? `${code} (${text})` : code);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}
/** Where a response stopped matching its schema, or its status, as safe failure details. */
const responseDetails = (error: ResponseError) =>
  error.schema
    ? { at: error.schema.at, expected: error.schema.expected }
    : { status: error.status };

/** Writes `text` to `url` whole or not at all: a crash mid-write leaves the old file. */
const writeText = (url: URL, text: string) => {
  NodeFS.mkdirSync(new URL(".", url), { recursive: true });
  const partial = new URL(`${url.href}.${process.pid}.partial`);
  NodeFS.writeFileSync(partial, text);
  NodeFS.renameSync(partial, url);
};
/** A JSON file's contents, or null when it's missing or damaged (cut short by a crash). */
const readJson = (url: URL): unknown => {
  if (!NodeFS.existsSync(url)) return null;
  try {
    return JSON.parse(NodeFS.readFileSync(url, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};
/** The remembered state, or null when there's none or it doesn't decode. */
const readState = (dir: URL): State | null => {
  const raw = readJson(new URL("onshape.json", dir));
  if (raw === null) return null;
  try {
    const decoded = stateSchema.decode(raw, "onshape.json");
    return {
      document: decoded.document,
      studios: { ...decoded.studios },
      emptyPartStudio: decoded.emptyPartStudio,
    };
  } catch (error) {
    if (!(error instanceof S.DecodeError)) throw error;
    return null;
  }
};
/** How many pages of document search results to read before giving up. */
const MAX_SEARCH_PAGES = 25;

/** Cases among `cases` without a current recording in `dir`. */
export const pendingCases = (cases: readonly ConformanceCase[], dir: URL): ConformanceCase[] =>
  cases.filter((c) => loadRecording(c, dir)?.kind !== "current");

/** Every query input with an expression, including those inside list items, with its path. */
const queryParameters = (
  parameters: CaseFeature["parameters"],
  prefix = "",
): { readonly parameter: Parameter; readonly expression: string; readonly path: string }[] =>
  Object.entries(parameters ?? {}).flatMap(([id, parameter]) =>
    parameter.kind === "query"
      ? parameter.expression === null
        ? []
        : [{ parameter, expression: parameter.expression, path: `${prefix}${id}` }]
      : parameter.kind === "array"
        ? parameter.items.flatMap((item, i) => queryParameters(item, `${prefix}${id}[${i}].`))
        : [],
  );

/** About how many API calls recording `cases` takes, for a dry run. */
export function estimateCalls(cases: readonly ConformanceCase[], dir: URL): number {
  const state = readState(dir) ?? emptyState();
  const sources = new Set(cases.flatMap((c) => c.features.map((feature) => feature.source)));
  const newSources = [...sources].filter((file) => !state.studios[sourceHash(readSource(file))]);
  // A remembered Feature Studio is checked once per run.
  const rememberedSources = sources.size - newSources.length;
  // sessioninfo, then checking the remembered document, or searching for and creating one.
  const document = state.document ? 2 : 3;
  return (
    (cases.length > 0 ? document : 0) +
    newSources.length * 3 +
    rememberedSources +
    cases.reduce(
      (sum, c) =>
        sum +
        (c.features.length > 0 || !state.emptyPartStudio ? 1 : 0) +
        c.features.length +
        c.features.filter((feature) => queryParameters(feature.parameters).length > 0).length +
        1,
      0,
    )
  );
}

/** Whether a document is the scratch document: that exact name, created and owned by `me`. */
const isScratch = (info: DocumentInfo, me: string) =>
  info.name === DOCUMENT_NAME && info.createdBy.id === me && info.owner.id === me;

/** A spec parameter as the recording keeps it: its id, and its items' for a list. */
const trimParameter = (parameter: SpecParameter): SpecInput =>
  parameter.parameters
    ? { id: parameter.parameterId, items: parameter.parameters.map(trimParameter) }
    : { id: parameter.parameterId };

/** What the recorder remembers of a Feature Studio, from the specs Onshape lists for it. */
const studioStateOf = (file: string, elementId: string, specs: FeatureSpecList): StudioState => {
  const first = specs[0];
  return {
    file,
    elementId,
    namespace: first?.namespace
      ? first.namespace
      : first?.sourceMicroversionId
        ? `e${elementId}::m${first.sourceMicroversionId}`
        : null,
    features: specs.map((spec) => spec.featureType),
    specs: Object.fromEntries(
      specs.map((spec) => [spec.featureType, (spec.parameters ?? []).map(trimParameter)]),
    ),
  };
};
/** Whether two remembered Feature Studios say the same: features, namespace and input ids. */
const sameStudio = (a: StudioState, b: StudioState) =>
  a.namespace === b.namespace &&
  JSON.stringify(a.features) === JSON.stringify(b.features) &&
  JSON.stringify(a.features.map((feature) => a.specs[feature])) ===
    JSON.stringify(b.features.map((feature) => b.specs[feature]));

/** Records the cases among `cases` without a current recording in `options.dir`. */
export async function recordCases(
  cases: readonly ConformanceCase[],
  options: RecorderOptions,
): Promise<RecordSummary> {
  const { dir, credentials } = options;
  /** A value that would show the key in a spelling `exposedIn` checks is never written. */
  class CredentialEcho extends Error {}
  const persist = (url: URL, value: unknown) => {
    if (credentials.exposedInValue(value)) throw new CredentialEcho(url.pathname);
    const text = JSON.stringify(value, null, 2);
    writeText(url, `${credentials.redact(text)}\n`);
  };
  const log = (line: string) => options.log?.(credentials.safe(line));
  const stateFile = new URL("onshape.json", dir);
  const failuresFile = new URL("failures.json", dir);
  const api = new OnshapeClient(options.fetch, credentials);
  const pending = pendingCases(cases, dir);
  const recorded: string[] = [];
  const failed: Record<string, string> = {};
  if (pending.length === 0) return { calls: 0, recorded, failed, stopped: null, document: null };

  let state = readState(dir);
  if (!state && NodeFS.existsSync(stateFile))
    log("STATE_INVALID: the remembered state doesn't decode; starting over.");
  state ??= emptyState();
  const remembered = state;
  const writeState = () => persist(stateFile, remembered);
  const failures = (readJson(failuresFile) as Record<string, unknown> | null) ?? {};
  /** Sources whose Feature Studio this run couldn't read, so later cases don't upload them again. */
  const brokenStudios = new Map<string, CaseFailure>();
  /** Sources whose Feature Studio this run has seen exists. */
  const checkedStudios = new Set<string>();

  /**
   * The scratch document. Remembered ids are used only after Onshape confirms they're the scratch
   * document (and its own workspace); if Onshape says they're gone or someone else's, they're
   * dropped with everything remembered in them. A detail that doesn't decode stops the run.
   */
  async function scratchDocument(): Promise<ScratchDocument> {
    const me = (await api.send("GET", "/users/sessioninfo", sessionInfo)).id;
    if (remembered.document) {
      let info: DocumentInfo | null = null;
      try {
        info = await api.send("GET", route`/documents/${remembered.document.id}`, documentInfo);
      } catch (error) {
        if (!(error instanceof ResponseError) || (error.status !== 403 && error.status !== 404))
          throw error;
      }
      if (info && isScratch(info, me) && info.defaultWorkspace.id === remembered.document.workspace)
        return remembered.document;
      log(
        `STATE_STALE: the remembered document isn't "${DOCUMENT_NAME}" of this key's user; looking for it again.`,
      );
      Object.assign(remembered, emptyState());
      writeState();
    }
    let info = await searchScratch(me);
    if (!info) {
      info = await api.send("POST", "/documents", documentInfo, {
        name: DOCUMENT_NAME,
        description:
          "Conformance recordings for Cadsense's local FeatureScript runtime. Scratch space.",
        isPublic: false,
        ownerType: 0,
        ownerId: me,
      });
      // A document this run can't recognize would be created again on every run.
      if (!isScratch(info, me))
        throw new StopRun(
          `CREATED_UNRECOGNIZED: the new document isn't named "${DOCUMENT_NAME}" and owned by this key's user.`,
        );
    }
    remembered.document = { id: info.id, workspace: info.defaultWorkspace.id };
    writeState();
    return remembered.document;
  }

  /**
   * The oldest document the search lists that's the scratch document, or undefined once every page
   * has been read without one. A same-named result without full details is looked up; one that
   * can't be checked stops the run. Pages are requested by offset from our own query, never by the
   * URL a response gives; a next page that isn't a document search on Onshape, or doesn't move
   * forward, or more than 25 pages, also stop the run instead of ending in a second document.
   */
  async function searchScratch(me: string): Promise<DocumentInfo | undefined> {
    const query = `/documents?q=${encodeURIComponent(DOCUMENT_NAME)}&filter=0&sortColumn=createdAt&sortOrder=asc&limit=20`;
    let offset = 0;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      let listing: S.Infer<typeof documentListing>;
      try {
        listing = await api.send("GET", `${query}&offset=${offset}`, documentListing);
      } catch (error) {
        if (!(error instanceof ResponseError)) throw error;
        throw new StopRun(`SEARCH_UNREADABLE: ${error.message}`);
      }
      for (const item of listing.items) {
        if (item.name !== DOCUMENT_NAME) continue;
        let info: DocumentInfo;
        try {
          info = documentInfo.decode(item.raw, "search result");
        } catch (error) {
          if (!(error instanceof S.DecodeError)) throw error;
          let id: string;
          try {
            id = S.hexId.decode(item.id, "search result id");
          } catch {
            throw new StopRun(
              "SEARCH_CANDIDATE_UNVERIFIED: a document named like the scratch one has no valid id.",
            );
          }
          try {
            info = await api.send("GET", route`/documents/${id}`, documentInfo);
          } catch (lookup) {
            if (!(lookup instanceof ResponseError)) throw lookup;
            throw new StopRun(`SEARCH_CANDIDATE_UNVERIFIED: ${lookup.message}`);
          }
        }
        if (isScratch(info, me)) return info;
      }
      if (listing.next === undefined || listing.next === null || listing.next === "")
        return undefined;
      let next: URL;
      try {
        next = new URL(listing.next);
      } catch {
        throw new StopRun("SEARCH_NEXT_PAGE_FOREIGN: the next page isn't a URL.");
      }
      if (next.origin !== HOST || next.pathname !== "/api/v10/documents")
        throw new StopRun(
          `SEARCH_NEXT_PAGE_FOREIGN: the next page isn't a document search on ${HOST}.`,
        );
      const nextOffset = Number(next.searchParams.get("offset"));
      if (!Number.isInteger(nextOffset) || nextOffset <= offset)
        throw new StopRun("SEARCH_PAGES_LOOP: the next page doesn't move forward.");
      offset = nextOffset;
    }
    throw new StopRun(
      `SEARCH_TOO_LONG: the document search has more than ${MAX_SEARCH_PAGES} pages; not creating a document.`,
    );
  }

  /**
   * The Feature Studio for a source: the remembered one, if Onshape still has it as remembered,
   * else a new one with the source uploaded and its specs read. A remembered studio is checked once
   * per run by reading its specs: a 404 means it was deleted, and specs that no longer match what's
   * remembered (its features, namespace or inputs) mean it was changed; either way it's dropped and
   * made again (once: a 404 from the new one fails the case like any spec read).
   */
  async function studio(
    w: { readonly did: string; readonly wid: string },
    file: string,
  ): Promise<StudioState> {
    const source = readSource(file);
    const hash = sourceHash(source);
    const broken = brokenStudios.get(hash);
    if (broken) throw broken;
    const known = remembered.studios[hash];
    if (known && checkedStudios.has(hash)) return known;
    if (known) {
      try {
        const specs = (
          await api.send(
            "GET",
            route`/featurestudios/d/${w.did}/w/${w.wid}/e/${known.elementId}/featurespecs`,
            featureSpecs,
          )
        ).featureSpecs;
        if (sameStudio(studioStateOf(file, known.elementId, specs), known)) {
          checkedStudios.add(hash);
          return known;
        }
        // Someone changed it in the scratch document: what's remembered no longer describes it.
        log(
          `STATE_STALE: the remembered Feature Studio for ${file} has changed; creating another.`,
        );
        delete remembered.studios[hash];
        writeState();
      } catch (error) {
        if (error instanceof CredentialEchoError) {
          const failure = new CaseFailure("CREDENTIAL_ECHO", { file });
          brokenStudios.set(hash, failure);
          throw failure;
        }
        if (!(error instanceof ResponseError)) throw error;
        if (error.status !== 404) {
          const failure = new CaseFailure("SPECS_INVALID", { file, ...responseDetails(error) });
          brokenStudios.set(hash, failure);
          throw failure;
        }
        log(`STATE_STALE: the remembered Feature Studio for ${file} is gone; creating another.`);
        delete remembered.studios[hash];
        writeState();
      }
    }
    const elementId = (
      await api.send("POST", route`/featurestudios/d/${w.did}/w/${w.wid}`, elementCreated, {
        name: `${file} ${hash.slice(0, 8)}`,
      })
    ).id;
    await api.send("POST", route`/featurestudios/d/${w.did}/w/${w.wid}/e/${elementId}`, S.unknown, {
      contents: source,
    });
    /** The spec list; a response that isn't one fails the case and isn't remembered. */
    const readSpecs = async () => {
      try {
        return (
          await api.send(
            "GET",
            route`/featurestudios/d/${w.did}/w/${w.wid}/e/${elementId}/featurespecs`,
            featureSpecs,
          )
        ).featureSpecs;
      } catch (error) {
        if (!(error instanceof ResponseError || error instanceof CredentialEchoError)) throw error;
        const failure =
          error instanceof CredentialEchoError
            ? new CaseFailure("CREDENTIAL_ECHO", { file })
            : new CaseFailure("SPECS_INVALID", { file, ...responseDetails(error) });
        brokenStudios.set(hash, failure);
        throw failure;
      }
    };
    let specs = await readSpecs();
    // Only a well-formed, empty spec list says the source doesn't compile; give a slow compile one
    // more look first.
    if (specs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 3000));
      specs = await readSpecs();
    }
    const studioState = studioStateOf(file, elementId, specs);
    if (credentials.exposedInValue(studioState)) {
      const failure = new CaseFailure("CREDENTIAL_ECHO", { file });
      brokenStudios.set(hash, failure);
      throw failure;
    }
    remembered.studios[hash] = studioState;
    checkedStudios.add(hash);
    writeState();
    return studioState;
  }

  async function recordCase(
    document: ScratchDocument,
    conformanceCase: ConformanceCase,
    hash: string,
  ): Promise<Recording> {
    const w = { did: document.id, wid: document.workspace };
    const files = [...new Set(conformanceCase.features.map((feature) => feature.source))];
    const studios = new Map<string, StudioState>();
    for (const file of files) studios.set(file, await studio(w, file));
    const sources: SourceRecord[] = files.map((file) => {
      const used = conformanceCase.features.filter((feature) => feature.source === file);
      const studioState = studios.get(file)!;
      const compiled = used.every((feature) => studioState.features.includes(feature.feature));
      const version = Number(/^FeatureScript (\d+);/m.exec(readSource(file))?.[1]);
      if (!Number.isFinite(version))
        throw new Error(`${file} has no FeatureScript version header.`);
      return {
        file,
        version,
        compiled,
        specs: Object.fromEntries(
          used.flatMap((feature) => {
            const inputs = studioState.specs[feature.feature];
            return inputs ? [[feature.feature, { parameters: inputs }]] : [];
          }),
        ),
      };
    });
    const recording = {
      case: conformanceCase.name,
      hash,
      recordedAt: new Date().toISOString(),
      sources,
    };
    // Onshape not compiling a source is ground truth too.
    if (sources.some((source) => !source.compiled))
      return { ...recording, onshapeVersion: null, partStudio: null, features: [], probe: null };

    const featureless = conformanceCase.features.length === 0;
    /** A new Part Studio in the scratch document; for featureless cases, remembered and shared. */
    const createPartStudio = async () => {
      const id = (
        await api.send("POST", route`/partstudios/d/${w.did}/w/${w.wid}`, elementCreated, {
          name: featureless
            ? "Cases without features"
            : `${conformanceCase.name} ${hash.slice(0, 8)}`,
        })
      ).id;
      if (featureless) {
        remembered.emptyPartStudio = id;
        writeState();
      }
      return id;
    };
    const rememberedPartStudio = featureless ? remembered.emptyPartStudio : null;
    let ps = rememberedPartStudio ?? (await createPartStudio());
    const evaluate = (script: string) =>
      api.send(
        "POST",
        route`/partstudios/d/${w.did}/w/${w.wid}/e/${ps}/featurescript`,
        evaluation,
        {
          script,
          queries: [],
        },
      );

    const featureIds: string[] = [];
    const features: FeatureRecord[] = [];
    for (const feature of conformanceCase.features) {
      const studioNamespace = studios.get(feature.source)!.namespace ?? "";
      const queries = queryParameters(feature.parameters);
      const resolved = new Map<Parameter, readonly string[]>();
      if (queries.length > 0) {
        // One call resolves all of this feature's query inputs, in the Part Studio as it is now.
        const input = queries.map(({ path }) => path).join(", ");
        let ids: readonly (readonly string[])[];
        try {
          const { result } = await evaluate(`function(context is Context, queries)
{
    return [${queries
      .map(
        ({ expression }) =>
          `transientQueriesToStrings(evaluateQuery(context, ${withFeatureIds(expression, featureIds)}))`,
      )
      .join(", ")}];
}`);
          ids = S.array(S.array(entityId), queries.length).decode(
            onshapeValue.decode(result, "result"),
            "result",
          );
        } catch (error) {
          if (error instanceof CredentialEchoError)
            throw new CaseFailure("CREDENTIAL_ECHO", { input });
          if (error instanceof ResponseError)
            throw new CaseFailure(error.schema ? "QUERY_RESPONSE" : "QUERY_HTTP", {
              input,
              ...responseDetails(error),
            });
          if (error instanceof S.DecodeError)
            throw new CaseFailure("QUERY_RESPONSE", {
              input,
              at: error.path,
              expected: error.expected,
            });
          throw error;
        }
        queries.forEach(({ parameter, path }, i) => {
          const entry = ids[i]!;
          if (entry.length === 0) throw new CaseFailure("QUERY_EMPTY", { input: path });
          resolved.set(parameter, entry);
        });
      }
      const added = await api.send(
        "POST",
        route`/partstudios/d/${w.did}/w/${w.wid}/e/${ps}/features`,
        featureAdded,
        {
          btType: "BTFeatureDefinitionCall-1406",
          feature: {
            btType: "BTMFeature-134",
            featureType: feature.feature,
            name: feature.feature,
            namespace: studioNamespace,
            suppressed: false,
            parameters: Object.entries(feature.parameters ?? {}).map(([id, parameter]) =>
              onshapeParameter(id, parameter, studioNamespace, resolved),
            ),
          },
        },
      );
      featureIds.push(added.feature.featureId);
      features.push({
        feature: feature.feature,
        featureId: added.feature.featureId,
        status: added.featureState.featureStatus,
        queries: Object.fromEntries(
          queries.map(({ parameter, path }) => [path, resolved.get(parameter) ?? []]),
        ),
      });
    }

    /** The probe's response; one that fails is the case's failure (CaseFailure), nothing else. */
    const probeIn = async (): Promise<S.Infer<typeof evaluation>> => {
      try {
        return await evaluate(onshapeProbe(conformanceCase, featureIds));
      } catch (error) {
        if (error instanceof CredentialEchoError) throw new CaseFailure("CREDENTIAL_ECHO");
        if (!(error instanceof ResponseError)) throw error;
        throw new CaseFailure(
          error.schema ? "PROBE_RESPONSE" : "PROBE_HTTP",
          responseDetails(error),
          error.status,
        );
      }
    };
    let probe: S.Infer<typeof evaluation>;
    try {
      probe = await probeIn();
    } catch (error) {
      // The remembered Part Studio for featureless cases was deleted: make another, once. Making it
      // fails like any other create (it stops the run); only the probe's own failure fails the case.
      if (!(error instanceof CaseFailure) || error.status !== 404 || ps !== rememberedPartStudio)
        throw error;
      log(
        "STATE_STALE: the remembered Part Studio for cases without features is gone; creating another.",
      );
      ps = await createPartStudio();
      probe = await probeIn();
    }
    let result: ProbeResult;
    try {
      result = probeSchemaFor(conformanceCase).decode(
        onshapeValue.decode(probe.result, "probe"),
        "probe",
      );
    } catch (error) {
      if (!(error instanceof S.DecodeError)) throw error;
      throw new CaseFailure("PROBE_SCHEMA", { at: error.path, expected: error.expected });
    }
    return {
      ...recording,
      onshapeVersion: probe.libraryVersion ?? null,
      partStudio: `${HOST}/documents/${w.did}/w/${w.wid}/e/${ps}`,
      features,
      probe: { result },
    };
  }

  let stopped: string | null = null;
  try {
    const document = await scratchDocument();
    for (const conformanceCase of pending) {
      const hash = caseHash(conformanceCase);
      try {
        const recording = await recordCase(document, conformanceCase, hash);
        try {
          persist(new URL(`${conformanceCase.name}.json`, dir), recording);
        } catch (error) {
          if (error instanceof CredentialEcho) throw new CaseFailure("CREDENTIAL_ECHO");
          throw error;
        }
        delete failures[conformanceCase.name];
        recorded.push(conformanceCase.name);
        log(
          `${conformanceCase.name}: ${recording.probe ? "recorded" : "doesn't compile in Onshape"}`,
        );
      } catch (error) {
        if (!(error instanceof CaseFailure)) throw error;
        failed[conformanceCase.name] = credentials.safe(error.message);
        failures[conformanceCase.name] = {
          hash,
          failedAt: new Date().toISOString(),
          code: error.code,
          ...error.details,
        };
        log(`${conformanceCase.name}: failed, left pending. ${error.message}`);
      } finally {
        if (Object.keys(failures).length > 0 || NodeFS.existsSync(failuresFile))
          persist(failuresFile, failures);
      }
    }
  } catch (error) {
    if (
      !(
        error instanceof QuotaError ||
        error instanceof TransportError ||
        error instanceof ResponseError ||
        error instanceof StopRun ||
        error instanceof CredentialEcho ||
        error instanceof CredentialEchoError
      )
    )
      // A bug in the recorder: rethrown as text with every message checked, so no cause chain
      // carries a credential; the text keeps the stack.
      // oxlint-disable-next-line preserve-caught-error -- the cause may hold the credential.
      throw new Error(describeThrown(error, credentials));
    stopped = credentials.safe(
      error instanceof CredentialEcho
        ? "CREDENTIAL_ECHO: refused to write the recorder's state"
        : error.message,
    );
  }
  return { calls: api.calls, recorded, failed, stopped, document: remembered.document };
}

/** A case input as an Onshape feature parameter; query inputs take the ids in `resolved`. */
function onshapeParameter(
  parameterId: string,
  parameter: Parameter,
  namespace: string,
  resolved: ReadonlyMap<Parameter, readonly string[]>,
): unknown {
  switch (parameter.kind) {
    case "length":
    case "angle":
    case "integer":
    case "real":
      return {
        btType: "BTMParameterQuantity-147",
        parameterId,
        expression:
          parameter.kind === "length"
            ? `${parameter.millimeters} mm`
            : parameter.kind === "angle"
              ? `${parameter.degrees} deg`
              : String(parameter.value),
      };
    case "boolean":
      return { btType: "BTMParameterBoolean-144", parameterId, value: parameter.value };
    case "string":
      return { btType: "BTMParameterString-149", parameterId, value: parameter.value };
    case "enum":
      return {
        btType: "BTMParameterEnum-145",
        parameterId,
        enumName: parameter.enumName,
        value: parameter.value,
        namespace,
      };
    case "query":
      return {
        btType: "BTMParameterQueryList-148",
        parameterId,
        queries: (resolved.get(parameter) ?? []).map((id) => ({
          btType: "BTMIndividualQuery-138",
          deterministicIds: [id],
        })),
      };
    case "array":
      return {
        btType: "BTMParameterArray-2025",
        parameterId,
        items: parameter.items.map((item) => ({
          btType: "BTMArrayParameterItem-1843",
          parameters: Object.entries(item).map(([id, inner]) =>
            onshapeParameter(id, inner, namespace, resolved),
          ),
        })),
      };
  }
}
