import type { Credentials } from "./Redaction.ts";
import * as S from "./Schema.ts";

/**
 * The slice of Onshape's REST API the recorder uses. {@link OnshapeClient.send} is where every
 * response body enters: it's checked for the key as received, before anything decodes it, then
 * decoded through one of the schemas below, the recorder's one validation boundary. A body that
 * doesn't match its schema is an error, never a default. Every id that goes into a request path or
 * a script must be in Onshape's format, and paths are built by {@link route}, which also encodes
 * each id. Errors carry fixed fields only (method, path, status, which schema field), never a body.
 */

export const HOST = "https://cad.onshape.com";
export const API = `${HOST}/api/v10`;

/** A feature's id, as Onshape gives it when the feature is added: it goes into the probe script. */
const featureId = S.string(/^[A-Za-z0-9_]{1,64}$/, "a feature id");
/** A resolved entity's deterministic id: it goes into a feature's query parameter. */
export const entityId = S.string(/^[A-Za-z0-9_]{1,64}$/, "an entity id");
/** A Feature Studio's namespace: its element id and microversion. */
export const namespace = S.string(
  /^e[0-9a-f]{24}::m[0-9a-f]{24}$/,
  "a namespace e<element>::m<microversion>",
);

/**
 * A request path: the literal parts as written, each interpolated id encoded with
 * `encodeURIComponent`. Ids are checked against their format before they get here; this is the
 * second line, so no id can add a path segment.
 */
export const route = (parts: TemplateStringsArray, ...ids: readonly string[]): string =>
  parts.reduce(
    (path, part, i) => path + part + (i < ids.length ? encodeURIComponent(ids[i]!) : ""),
    "",
  );

/**
 * A response that holds the key, in a spelling {@link Credentials.exposedIn} checks, anywhere in
 * the body as received: any string, any key, any status. Refused unread.
 */
export class CredentialEchoError extends Error {}
/** HTTP 402 or 429: the account is out of API calls. Stops the run. */
export class QuotaError extends Error {}
/** A request that got no response at all. Stops the run. */
export class TransportError extends Error {}
/** A response that isn't a 2xx, or whose body doesn't match its schema. */
export class ResponseError extends Error {
  readonly status: number;
  /** For a body that didn't decode: where, and what was expected. Built from the schema alone. */
  readonly schema: { readonly at: string; readonly expected: string } | null;
  constructor(message: string, status: number, schema: ResponseError["schema"]) {
    super(message);
    this.status = status;
    this.schema = schema;
  }
}

/** `GET /users/sessioninfo`: the key's user. */
export const sessionInfo = S.object({ id: S.hexId });

/** `GET /documents/{did}` and a full search result: what tells whether it's the scratch document. */
export const documentInfo = S.object({
  id: S.hexId,
  name: S.string(),
  createdBy: S.object({ id: S.hexId }),
  owner: S.object({ id: S.hexId }),
  defaultWorkspace: S.object({ id: S.hexId }),
});
export type DocumentInfo = S.Infer<typeof documentInfo>;

/**
 * A search result: every item has an id and a name, and the whole item is kept, to read in full if
 * it's named like the scratch document. Other documents' ids are never used, so they aren't checked.
 */
const listingItem = S.custom((value, path) => ({
  ...S.object({ id: S.string(), name: S.string() }).decode(value, path),
  raw: value,
}));
/** `GET /documents?q=...`: a page of results, and the next page's URL. */
export const documentListing = S.object({
  items: S.array(listingItem),
  next: S.optional(S.nullable(S.string())),
});

/** `POST /featurestudios/...` and `POST /partstudios/...`: the new element. */
export const elementCreated = S.object({ id: S.hexId });

export interface SpecParameter {
  readonly parameterId: string;
  readonly parameters?: readonly SpecParameter[];
}
const specParameter: S.Schema<SpecParameter> = S.lazy(() =>
  S.object({ parameterId: S.identifier, parameters: S.optional(S.array(specParameter)) }),
);
/** `GET .../featurespecs`: one spec per feature the Feature Studio compiled; none if it didn't. */
export const featureSpecs = S.object({
  featureSpecs: S.array(
    S.object({
      featureType: S.identifier,
      namespace: S.optional(namespace),
      sourceMicroversionId: S.optional(S.hexId),
      parameters: S.optional(S.array(specParameter)),
    }),
  ),
});
export type FeatureSpecList = S.Infer<typeof featureSpecs>["featureSpecs"];

/** `POST .../features`: the added feature's id and status. */
export const featureAdded = S.object({
  feature: S.object({ featureId }),
  featureState: S.object({
    featureStatus: S.literal("OK", "INFO", "WARNING", "ERROR", "UNKNOWN"),
  }),
});

/**
 * `POST .../featurescript`: the script's result, still encoded, and the version it ran at. The
 * caller decodes the result with Plain.ts's `onshapeValue` and its own schema, so a result that
 * doesn't decode is a failure of what the script returned (the probe's or the query's), not of the
 * response.
 */
export const evaluation = S.object({
  result: S.present,
  libraryVersion: S.optional(S.number),
});

/**
 * How deeply a response may nest. The recorder's real responses nest a few dozen levels; the schemas
 * and decoders recurse, so a body nested thousands of levels deep is refused before they run.
 */
const MAX_RESPONSE_DEPTH = 256;

/** Whether parsed JSON nests deeper than `limit`, measured with an explicit stack. */
const deeperThan = (value: unknown, limit: number): boolean => {
  const pending: [unknown, number][] = [[value, 0]];
  while (pending.length > 0) {
    const [next, depth] = pending.pop()!;
    if (typeof next !== "object" || next === null) continue;
    if (depth >= limit) return true;
    for (const entry of Array.isArray(next) ? next : Object.values(next))
      pending.push([entry, depth + 1]);
  }
  return false;
};

/** A thrown value's constructor name, if it's a plain word; it's all a transport error keeps. */
const thrownName = (thrown: unknown): string => {
  const name = thrown instanceof Error ? thrown.name : typeof thrown;
  return /^[A-Za-z]{1,40}$/.test(name) ? name : "error";
};

/** Onshape's API with a key: counts calls, decodes every response, keeps no response text. */
export class OnshapeClient {
  calls = 0;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly #credentials: Credentials;

  constructor(
    fetch: (url: string, init: RequestInit) => Promise<Response>,
    credentials: Credentials,
  ) {
    this.#fetch = fetch;
    this.#credentials = credentials;
  }

  /**
   * Sends one request to `path` (built with {@link route}) and decodes its 2xx body with `schema`.
   * First, whatever the status, the body is checked as received: its raw text, and every string
   * and key of its parsed JSON, before any decoding can turn a key into text. One that holds the
   * key throws {@link CredentialEchoError}. Then 402 and 429 throw {@link QuotaError}; a fetch that
   * rejects throws {@link TransportError}; any other status, a body nested deeper than
   * {@link MAX_RESPONSE_DEPTH} levels, or a body the schema rejects, throws {@link ResponseError}. Their messages hold the method, path, status and schema position: never
   * the response or the thrown value.
   */
  async send<T>(
    method: "GET" | "POST",
    path: string,
    schema: S.Schema<T>,
    body?: unknown,
  ): Promise<T> {
    this.calls += 1;
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(`${API}${path}`, {
        method,
        redirect: "manual",
        headers: {
          Authorization: this.#credentials.header(),
          Accept: "application/json;charset=UTF-8; qs=0.09",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new TransportError(
        `TRANSPORT_FAILED: ${method} ${path}: the request failed (${thrownName(error)})`,
      );
    }
    let raw: unknown;
    try {
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = undefined;
    }
    if (this.#credentials.exposedIn(text) || this.#credentials.exposedInValue(raw))
      throw new CredentialEchoError(
        `CREDENTIAL_ECHO: ${method} ${path} -> HTTP ${status}: the response holds the API key; refused unread`,
      );
    if (status === 402 || status === 429)
      throw new QuotaError(`QUOTA: ${method} ${path} -> HTTP ${status}`);
    if (status < 200 || status >= 300)
      throw new ResponseError(`HTTP_ERROR: ${method} ${path} -> HTTP ${status}`, status, null);
    if (deeperThan(raw, MAX_RESPONSE_DEPTH)) {
      const expected = `nested at most ${MAX_RESPONSE_DEPTH} levels deep`;
      throw new ResponseError(
        `RESPONSE_SCHEMA: ${method} ${path}: response should be ${expected}`,
        status,
        {
          at: "response",
          expected,
        },
      );
    }
    try {
      return schema.decode(raw, "response");
    } catch (error) {
      if (!(error instanceof S.DecodeError)) throw error;
      throw new ResponseError(
        `RESPONSE_SCHEMA: ${method} ${path}: ${error.path} should be ${error.expected}`,
        status,
        { at: error.path, expected: error.expected },
      );
    }
  }
}
