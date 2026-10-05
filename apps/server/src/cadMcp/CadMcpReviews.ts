import {
  CAD_TOOL_INPUTS,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  onshapeProjectSourceIdentity,
  ProjectId,
  ThreadId,
  TurnId,
  type OnshapeConnectionError,
  type OnshapeConnectionSummary,
  type OnshapeProjectSource,
} from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CadRenderBroker } from "../cad/CadRenderBroker.ts";
import { CadUserOperations } from "../cad/CadUserOperations.ts";
import { CadViewing } from "../cad/CadViewing.ts";
import { ServerConfig } from "../config.ts";
import { OnshapeConnections } from "../onshape/OnshapeConnections.ts";
import { OnshapeProjects } from "../onshape/OnshapeProjects.ts";
import * as OnshapeSourceUrl from "../onshape/OnshapeSourceUrl.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CAD_REVIEW_INSTRUCTIONS } from "../provider/CadReviewInstructions.ts";
import {
  makeCadProviderTools,
  mcpCadToolError,
  mcpCadToolResult,
  type CadProviderTools,
} from "../provider/CadProviderTools.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import type { CadMcpRenderHost } from "./CadMcpRenderHost.ts";
import { writeCadMcpReport } from "./CadMcpReport.ts";
import type { CadMcpToolResult } from "./CadMcpStdio.ts";
import { CadOpenInput, type OnshapeApiKey } from "./CadMcpTools.ts";

export class CadMcpOpenError extends Schema.TaggedErrorClass<CadMcpOpenError>()("CadMcpOpenError", {
  reason: Schema.String,
  details: Schema.String,
}) {}

// Codex gives each MCP call 60 seconds by default. Return before that and let the agent call again.
const IMPORT_WAIT_MS = 45_000;
const decodeOpenInput = Schema.decodeUnknownEffect(CadOpenInput);
const CONNECTION_NAME = "Cadsense MCP";
const RENDER_TOOLS = new Set(["cad_capture", "cad_comment_locate", "cad_comment_inspect"]);

const describeConnectionError = (error: OnshapeConnectionError) => {
  switch (error._tag) {
    case "OnshapeInvalidCredentialsError":
      return "Onshape rejected ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY. Check both values.";
    case "OnshapeInsufficientPermissionsError":
      return "This Onshape API key lacks read access to documents.";
    case "OnshapeRateLimitError":
    case "OnshapeVerificationThrottledError":
    case "OnshapeAnnualQuotaExceededError":
      return "Onshape is limiting requests for this API key. Try again later.";
    case "OnshapeNetworkError":
      return "Could not reach Onshape. Check the network connection.";
    default:
      return `Onshape did not accept the connection (${error._tag}).`;
  }
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const textResult = (value: unknown, isError = false): CadMcpToolResult => ({
  isError,
  structuredContent: value,
  content: [{ type: "text", text: encodeJson(value) }],
});

interface Review {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly tools: CadProviderTools;
  readonly scope: Scope.Closeable;
  readonly title: string;
  readonly sourceUrl: string;
  readonly reportDirectory: string;
}

/**
 * Says what is wrong with an Onshape tab URL, or null when its shape is right. It needs no network,
 * so cad_open runs it before contacting Onshape: models copy long URLs badly (dropped characters, a
 * dropped /e/ tab), and a later network error would hide the real problem.
 */
export const onshapeUrlProblem = (url: string) => {
  const generic =
    "Use the URL of an Onshape tab exactly as the user gave it: https://cad.onshape.com/documents/<id>/w|v|m/<id>/e/<elementId>.";
  if (!URL.canParse(url)) return generic;
  const path = new URL(url).pathname.split("/").filter(Boolean);
  if (path[0] !== "documents" || !["w", "v", "m"].includes(path[2] ?? "")) return generic;
  const ids: ReadonlyArray<readonly [index: number, label: string]> = [
    [1, "document ID after /documents/"],
    [3, `ID after /${path[2]}/`],
    [5, "element ID after /e/"],
  ];
  for (const [index, label] of ids) {
    const id = path[index];
    if (id !== undefined && !/^[0-9a-f]{24}$/i.test(id))
      return `The ${label} has ${id.length} characters, but Onshape IDs have 24 hex characters. Copy the URL again character for character from the user's message. ${generic}`;
  }
  if (path.length === 4)
    return "The URL opens a document, not a tab. Copy the user's URL again exactly: it continues with /e/<elementId>.";
  return path.length === 6 && path[4] === "e" ? null : generic;
};

/**
 * Reviews opened by one `cadsense mcp` process. The process is the MCP session, so every call comes
 * from one client and needs no per-call capability token. Each opened review is a Cadsense chat in
 * the MCP data directory, with a synthetic turn ID that scopes its CAD activation, captures, and
 * comments the same way a provider turn does.
 */
export const makeCadMcpReviews = Effect.fn("makeCadMcpReviews")(function* (options: {
  readonly apiKey: Option.Option<OnshapeApiKey>;
  readonly renderHost: CadMcpRenderHost;
  readonly clientName: () => string;
}) {
  const connections = yield* OnshapeConnections;
  const onshapeProjects = yield* OnshapeProjects;
  const operations = yield* CadUserOperations;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const broker = yield* CadRenderBroker;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const owner = yield* Scope.Scope;
  // Provided to activations and reports created later, outside this constructor.
  const context = yield* Effect.context<
    CadViewing | ServerConfig | Path.Path | FileSystem.FileSystem | SqlClient.SqlClient
  >();
  const gate = yield* Semaphore.make(1);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const fail = (reason: string, details: string) => new CadMcpOpenError({ reason, details });

  const verified = new Map<string, OnshapeConnectionSummary>();
  // The CAD operation this process started for each project and still waits on.
  const started = new Map<ProjectId, { kind: "discover" | "sync"; operationId: string }>();
  const discovered = new Set<ProjectId>();
  const synced = new Set<ProjectId>();
  let current: Review | null = null;

  /** One verification request per host per process keeps the stored key equal to the env key. */
  const connectionFor = Effect.fn("CadMcpReviews.connectionFor")(function* (host: string) {
    const known = verified.get(host);
    if (known) return known;
    if (Option.isNone(options.apiKey))
      return yield* fail(
        "missing-onshape-key",
        "Set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY in this MCP server's environment. Create a key at https://dev-portal.onshape.com/keys with read access.",
      );
    const key = {
      host,
      ...options.apiKey.value,
      secretKey: Redacted.value(options.apiKey.value.secretKey),
    };
    const listed = yield* connections
      .list()
      .pipe(Effect.mapError((error) => fail("onshape-connection", describeConnectionError(error))));
    const existing = listed.connections.find(
      (entry) => entry.host === host && entry.name === CONNECTION_NAME,
    );
    const connection = yield* (
      existing
        ? connections.replaceCredentials({ connectionId: existing.connectionId, ...key })
        : connections.create({ name: CONNECTION_NAME, ...key })
    ).pipe(Effect.mapError((error) => fail("onshape-connection", describeConnectionError(error))));
    verified.set(host, connection);
    return connection;
  });

  const projectFor = Effect.fn("CadMcpReviews.projectFor")(function* (
    source: OnshapeProjectSource,
    url: string,
    title: string,
  ) {
    const identity = onshapeProjectSourceIdentity(source);
    const existing = (yield* query.getCommandReadModel()).projects.find(
      (project) =>
        project.deletedAt === null &&
        project.onshapeSource !== undefined &&
        onshapeProjectSourceIdentity(project.onshapeSource) === identity,
    );
    if (existing) return existing.id;
    const projectId = ProjectId.make(yield* uuid);
    yield* onshapeProjects.create({ projectId, title, connectionId: source.connectionId, url });
    return projectId;
  });

  /**
   * A microversion URL (/m/) names CAD that can never change, so when this data directory already
   * holds that microversion of the element, the review opens from it without contacting Onshape:
   * no key verification and no sync. Workspace and version URLs still sync.
   */
  const storedMicroversion = Effect.fn("CadMcpReviews.storedMicroversion")(function* (
    url: string,
    host: string,
  ) {
    const listed = yield* connections.list().pipe(Effect.option);
    const connection = Option.isSome(listed)
      ? listed.value.connections.find(
          (entry) => entry.host === host && entry.name === CONNECTION_NAME,
        )
      : undefined;
    if (!connection) return null;
    const parsed = yield* OnshapeSourceUrl.parse({ url, connection }).pipe(Effect.option);
    if (Option.isNone(parsed) || parsed.value.workspaceType !== "m" || !parsed.value.elementId)
      return null;
    const source = parsed.value;
    const identity = onshapeProjectSourceIdentity(source);
    const project = (yield* query.getCommandReadModel()).projects.find(
      (entry) =>
        entry.deletedAt === null &&
        entry.onshapeSource !== undefined &&
        onshapeProjectSourceIdentity(entry.onshapeSource) === identity,
    );
    if (!project) return null;
    const shell = yield* query.getProjectShellById(project.id);
    const current = Option.isSome(shell)
      ? shell.value.cad?.roots.find(
          // Syncs store an unconfigured root as "default", the same rule CadUserOperations applies.
          (root) =>
            root.elementId === source.elementId &&
            root.configuration === (source.configuration || "default"),
        )?.current
      : undefined;
    if (current?.microversionId !== source.workspaceId) return null;
    synced.add(project.id);
    return { connection, source };
  });

  /** Drives discover then sync for the URL's element. Returns false if still importing at the deadline. */
  const importRoot = Effect.fn("CadMcpReviews.importRoot")(function* (
    projectId: ProjectId,
    source: OnshapeProjectSource & { readonly elementId: string },
  ) {
    const start = (input: Parameters<typeof operations.start>[0]) =>
      operations.start(input).pipe(
        Effect.mapError((error) =>
          fail(
            "import-failed",
            error.reason === "throttled"
              ? "Onshape asked Cadsense to slow down. Try again later."
              : `The CAD import could not start (${error.reason}).`,
          ),
        ),
        Effect.tap(({ operationId }) =>
          Effect.sync(() => started.set(projectId, { kind: input.kind, operationId })),
        ),
      );
    const deadline = (yield* Clock.currentTimeMillis) + IMPORT_WAIT_MS;
    while (true) {
      const project = yield* query.getProjectShellById(projectId);
      if (Option.isNone(project))
        return yield* fail("project-missing", "The review project was removed.");
      const cad = project.value.cad;
      const pending = started.get(projectId);
      if (cad?.operation || (pending && cad?.lastOutcome?.operationId !== pending.operationId)) {
        if ((yield* Clock.currentTimeMillis) >= deadline) return false;
        yield* Effect.sleep("1 second");
        continue;
      }
      if (pending) {
        started.delete(projectId);
        if (cad?.lastOutcome?.status !== "succeeded")
          return yield* fail("import-failed", cad?.lastOutcome?.reason ?? "The CAD import failed.");
        (pending.kind === "sync" ? synced : discovered).add(projectId);
        continue;
      }
      if (synced.has(projectId)) return true;
      const root = cad?.catalog?.roots.find((entry) => entry.elementId === source.elementId);
      if (root) {
        yield* start({
          projectId,
          kind: "sync",
          root: { elementId: root.elementId, kind: root.kind, configuration: source.configuration },
        });
        continue;
      }
      if (discovered.has(projectId))
        return yield* fail(
          "unsupported-element",
          "This Onshape tab is not an assembly or part studio Cadsense can open. Open an assembly or part studio tab and use its URL.",
        );
      yield* start({ projectId, kind: "discover" });
    }
  });

  const writeReport = (review: Review) =>
    writeCadMcpReport({
      threadId: review.threadId,
      directory: review.reportDirectory,
      title: review.title,
      sourceUrl: review.sourceUrl,
    }).pipe(Effect.provide(context));

  const closeReview = Effect.fn("CadMcpReviews.closeReview")(function* (review: Review) {
    yield* review.tools.close;
    // Closing runs the cad_checks draft backstop, which can publish, so refresh the report.
    yield* writeReport(review).pipe(
      Effect.catch((error) => Effect.logWarning("CAD review report was not written", error)),
    );
    yield* Scope.close(review.scope, Exit.void);
    yield* broker.endRun(review.turnId);
    yield* Effect.logInfo("CAD MCP review closed", { threadId: review.threadId });
  });

  const reviewFor = Effect.fn("CadMcpReviews.reviewFor")(function* (
    projectId: ProjectId,
    title: string,
    sourceUrl: string,
  ) {
    if (current?.projectId === projectId) return current;
    if (current) yield* closeReview(current);
    current = null;
    const threadId = ThreadId.make(yield* uuid);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* uuid),
      threadId,
      projectId,
      title: `${title} (${options.clientName()})`,
      modelSelection: getAutoBootstrapDefaultModelSelection(),
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    const scope = yield* Scope.fork(owner);
    // The MCP session is the review, so closing it publishes leftover drafts.
    const tools = yield* makeCadProviderTools(threadId, { settleOnClose: true }).pipe(
      Effect.provide(context),
      Effect.provideService(Scope.Scope, scope),
    );
    const review: Review = {
      projectId,
      threadId,
      turnId: TurnId.make(`mcp-${yield* uuid}`),
      tools,
      scope,
      title,
      sourceUrl,
      reportDirectory: path.join(config.baseDir, "reports", threadId),
    };
    current = review;
    return review;
  });

  const open = Effect.fn("CadMcpReviews.open")(function* (input: unknown) {
    const request = yield* decodeOpenInput(input).pipe(
      Effect.mapError(() =>
        fail("invalid-input", "Pass {url} with the Onshape tab URL, and optionally {title}."),
      ),
    );
    const host = yield* Effect.try({
      try: () => new URL(request.url).origin,
      catch: () => fail("invalid-url", "The url is not a valid Onshape URL."),
    });
    const problem = onshapeUrlProblem(request.url);
    if (problem) return yield* fail("invalid-url", problem);
    const stored = yield* storedMicroversion(request.url, host);
    const connection = stored?.connection ?? (yield* connectionFor(host));
    const source =
      stored?.source ??
      (yield* OnshapeSourceUrl.parse({ url: request.url, connection }).pipe(
        Effect.mapError((error) =>
          fail(
            "invalid-url",
            error._tag === "OnshapeProjectHostMismatchError"
              ? "The URL is not on the Onshape host this server's API key belongs to."
              : "Use an https Onshape tab URL with at most one configuration parameter.",
          ),
        ),
      ));
    const elementId = source.elementId;
    if (elementId === undefined)
      return yield* fail(
        "missing-element",
        "The URL opens a document, not a tab. Open the assembly or part studio tab and use its URL, which ends in /e/<elementId>.",
      );
    const title = request.title ?? "Onshape review";
    // Warm the renderer while the CAD downloads; failures surface again on the first capture.
    yield* options.renderHost.ensure.pipe(
      Effect.catch((error) => Effect.logWarning("CAD render host did not start", error)),
      Effect.forkIn(owner),
    );
    const projectId = yield* projectFor(source, request.url, title);
    if (!(yield* importRoot(projectId, { ...source, elementId })))
      return {
        status: "importing",
        details:
          "Still downloading this CAD. Call cad_open again with the same url to keep waiting.",
      };
    const review = yield* reviewFor(projectId, title, request.url);
    const delivery = yield* review.tools.invoke(null, review.turnId, "cad_context", {});
    const reportPath = yield* writeReport(review);
    return {
      status: "ready",
      reviewId: review.threadId,
      reportPath,
      context: delivery.result,
      reviewGuidance: CAD_REVIEW_INSTRUCTIONS,
    };
  });

  const callCadTool = Effect.fn("CadMcpReviews.callCadTool")(function* (
    name: string,
    input: unknown,
  ) {
    const review = current;
    if (!review)
      return textResult(
        {
          reason: "no-review",
          details: "No review is open. Call cad_open with the Onshape URL first.",
        },
        true,
      );
    if (RENDER_TOOLS.has(name)) {
      const host = yield* options.renderHost.ensure.pipe(Effect.result);
      if (Result.isFailure(host))
        return textResult({ reason: "render-unavailable", details: host.failure.message }, true);
    }
    const result = yield* review.tools.invoke(null, review.turnId, name, input).pipe(
      Effect.flatMap(mcpCadToolResult),
      Effect.catch((error) => Effect.succeed(mcpCadToolError(error))),
    );
    if (name !== "cad_comments_publish" || result.isError) return result;
    const reportPath = yield* writeReport(review).pipe(
      Effect.catch((error) =>
        Effect.logWarning("CAD review report was not written", error).pipe(Effect.as(null)),
      ),
    );
    return reportPath
      ? {
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: `Review report updated: ${reportPath}` },
          ],
        }
      : result;
  });

  const call = (name: string, input: unknown): Effect.Effect<CadMcpToolResult> =>
    name === "cad_open"
      ? gate
          .withPermits(1)(open(input))
          .pipe(
            Effect.map((result) => textResult(result)),
            Effect.catch((error) =>
              Effect.succeed(
                textResult(
                  error._tag === "CadMcpOpenError"
                    ? { reason: error.reason, details: error.details }
                    : error._tag === "CadViewError"
                      ? { reason: error.reason, details: error.details ?? "CAD is unavailable." }
                      : {
                          reason: "unavailable",
                          details: `Cadsense could not open this review (${error._tag}).`,
                        },
                  true,
                ),
              ),
            ),
          )
      : Object.hasOwn(CAD_TOOL_INPUTS, name)
        ? callCadTool(name, input)
        : Effect.succeed(textResult({ reason: "unknown-tool", details: name }, true));

  yield* Scope.addFinalizer(
    owner,
    Effect.suspend(() => (current ? closeReview(current) : Effect.void)).pipe(Effect.ignore),
  );
  return { call };
});
