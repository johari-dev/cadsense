#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const UPSTREAM_REF = "678157acaa819d5510adfe359abb5d0392cfe461";
const USER_AGENT = "effect-codex-app-server-generator";
const GITHUB_API_BASE =
  "https://api.github.com/repos/openai/codex/contents/codex-rs/app-server-protocol";

const CLIENT_REQUEST_METHODS = new Set([
  "account/read",
  "config/mcpServer/reload",
  "feedback/upload",
  "initialize",
  "model/list",
  "skills/list",
  "thread/read",
  "thread/resume",
  "thread/start",
  "turn/interrupt",
  "turn/start",
]);
const CLIENT_NOTIFICATION_METHODS = new Set(["initialized"]);
const SERVER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
const SERVER_NOTIFICATION_METHODS = new Set([
  "configWarning",
  "deprecationNotice",
  "error",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "mcpServer/oauthLogin/completed",
  "model/rerouted",
  "serverRequest/resolved",
  "thread/archived",
  "thread/closed",
  "thread/compacted",
  "thread/name/updated",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/started",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/unarchived",
  "turn/completed",
  "turn/plan/updated",
  "turn/started",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
]);

const APP_SCHEMA_ROOTS = new Set([
  "CommandExecutionRequestApprovalResponse",
  "FileChangeRequestApprovalResponse",
  "McpServerElicitationRequestParams",
  "McpServerElicitationRequestResponse",
  "ServerRequest__ApplyPatchApprovalParams",
  "ServerRequest__CommandExecutionRequestApprovalParams",
  "ServerRequest__DynamicToolCallParams",
  "ServerRequest__ExecCommandApprovalParams",
  "ServerRequest__FileChangeRequestApprovalParams",
  "ServerRequest__ToolRequestUserInputParams",
  "ServerRequest__ToolRequestUserInputQuestion",
  "ToolRequestUserInputParams",
  "ToolRequestUserInputParams__ToolRequestUserInputQuestion",
  "ToolRequestUserInputResponse",
  "ToolRequestUserInputResponse__ToolRequestUserInputAnswer",
  "V1InitializeParams",
  "V2AgentMessageDeltaNotification",
  "V2CommandExecutionOutputDeltaNotification",
  "V2ConfigWarningNotification",
  "V2DeprecationNoticeNotification",
  "V2ErrorNotification",
  "V2FeedbackUploadResponse",
  "V2FileChangeOutputDeltaNotification",
  "V2GetAccountResponse",
  "V2ItemCompletedNotification",
  "V2ItemStartedNotification",
  "V2McpServerOauthLoginCompletedNotification",
  "V2McpToolCallProgressNotification",
  "V2ModelListResponse",
  "V2ModelListResponse__Model",
  "V2ModelReroutedNotification",
  "V2PlanDeltaNotification",
  "V2ReasoningSummaryTextDeltaNotification",
  "V2ReasoningTextDeltaNotification",
  "V2ServerRequestResolvedNotification",
  "V2SkillsListResponse",
  "V2ThreadNameUpdatedNotification",
  "V2ThreadReadResponse",
  "V2ThreadRealtimeClosedNotification",
  "V2ThreadRealtimeErrorNotification",
  "V2ThreadRealtimeItemAddedNotification",
  "V2ThreadRealtimeOutputAudioDeltaNotification",
  "V2ThreadRealtimeStartedNotification",
  "V2ThreadStartedNotification",
  "V2ThreadStartParams",
  "V2ThreadStartParams__ApprovalsReviewer",
  "V2ThreadStartParams__AskForApproval",
  "V2ThreadStartParams__SandboxMode",
  "V2ThreadStatusChangedNotification",
  "V2ThreadTokenUsageUpdatedNotification",
  "V2TurnCompletedNotification",
  "V2TurnPlanUpdatedNotification",
  "V2TurnStartParams",
  "V2TurnStartParams__CollaborationMode",
  "V2TurnStartParams__ReasoningEffort",
  "V2TurnStartParams__SandboxPolicy",
  "V2TurnStartParams__UserInput",
  "V2TurnStartResponse",
  "V2WindowsSandboxSetupCompletedNotification",
  "V2WindowsWorldWritableWarningNotification",
]);

const THREAD_PROPERTIES = new Set([
  "agentNickname",
  "agentRole",
  "cliVersion",
  "createdAt",
  "cwd",
  "ephemeral",
  "id",
  "modelProvider",
  "name",
  "parentThreadId",
  "path",
  "preview",
  "recencyAt",
  "sessionId",
  "source",
  "status",
  "threadSource",
  "turns",
  "updatedAt",
]);
const PLUGIN_SOURCE_TYPES = new Set(["local", "npm"]);
const CODEX_ERROR_INFO_VALUES = new Set([
  "badRequest",
  "contextWindowExceeded",
  "cyberPolicy",
  "internalServerError",
  "other",
  "sandboxError",
  "serverOverloaded",
  "sessionBudgetExceeded",
  "unauthorized",
  "usageLimitExceeded",
]);

const GithubContentEntries = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    download_url: Schema.NullOr(Schema.String),
    type: Schema.String,
  }),
);
type GithubContentEntry = (typeof GithubContentEntries.Type)[number];

const JsonSchemaDocument = Schema.StructWithRest(
  Schema.Struct({
    definitions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const decodeGithubContentEntries = Schema.decodeEffect(Schema.fromJsonString(GithubContentEntries));
const decodeJsonSchemaDocument = Schema.decodeEffect(Schema.fromJsonString(JsonSchemaDocument));

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
  readonly namespacesOutputPath: string;
}

interface MethodEntry {
  readonly method: string;
  readonly paramsType?: string;
}

interface JsonSchemaFile {
  readonly namespace?: string;
  readonly exportName: string;
  readonly fileName: string;
  readonly downloadUrl: string;
  readonly qualifiedName: string;
}

class GeneratorError extends Schema.TaggedErrorClass<GeneratorError>()("GeneratorError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

const ManualSchemas: Record<string, Schema.Json> = {
  GetAuthStatusParams: {
    type: "object",
    title: "GetAuthStatusParams",
    properties: {
      includeToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
      refreshToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
  },
  GetConversationSummaryParams: {
    title: "GetConversationSummaryParams",
    oneOf: [
      {
        type: "object",
        properties: {
          rolloutPath: { type: "string" },
        },
        required: ["rolloutPath"],
      },
      {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
    ],
  },
  GetConversationSummaryResponse: {
    type: "object",
    title: "GetConversationSummaryResponse",
    properties: {
      summary: {},
    },
    required: ["summary"],
  },
  GetAuthStatusResponse: {
    type: "object",
    title: "GetAuthStatusResponse",
    properties: {
      authMethod: {
        anyOf: [{}, { type: "null" }],
      },
      authToken: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      requiresOpenaiAuth: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
    required: ["authMethod", "authToken", "requiresOpenaiAuth"],
  },
};

// Codex 0.150 added these multi-agent values before our next full protocol
// refresh. Keep every generated response namespace compatible with them.
const Codex0150DefinitionSchemas: Record<string, Schema.Json> = {
  CollabAgentTool: {
    type: "string",
    enum: [
      "spawnAgent",
      "sendInput",
      "resumeAgent",
      "wait",
      "closeAgent",
      "sendMessage",
      "followupTask",
      "interruptAgent",
      "listAgents",
    ],
  },
  CollabAgentToolCallStatus: {
    type: "string",
    enum: ["inProgress", "completed", "failed", "interrupted"],
  },
  PlanType: {
    type: "string",
    enum: [
      "free",
      "go",
      "plus",
      "pro",
      "prolite",
      "team",
      "self_serve_business_prolite",
      "self_serve_business_usage_based",
      "business",
      "ent26",
      "enterprise_cbp_automation",
      "enterprise_cbp_usage_based",
      "enterprise",
      "edu",
      "edu_plus",
      "edu_pro",
      "unknown",
    ],
  },
  SubAgentActivityKind: {
    type: "string",
    enum: ["started", "interacted", "interrupted", "completed"],
  },
};

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
    namespacesOutputPath: path.join(generatedDir, "namespaces.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();
  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

const fetchText = Effect.fn("fetchText")(function* (url: string) {
  return yield* HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("user-agent", USER_AGENT),
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((okResponse) => okResponse.text),
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: `Failed to fetch ${url}`,
          cause,
        }),
    ),
  );
});

const fetchDirectoryEntries = Effect.fn("fetchDirectoryEntries")(function* (path: string) {
  const raw = yield* fetchText(`${GITHUB_API_BASE}/${path}?ref=${UPSTREAM_REF}`);
  return yield* decodeGithubContentEntries(raw);
});

function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

function selectReachableSchemaEntries(
  entries: ReadonlyMap<string, string>,
  roots: ReadonlySet<string>,
): Map<string, string> {
  const allNames = new Set(entries.keys());
  const selectedNames = new Set<string>();
  const pending = [...roots];

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (selectedNames.has(name)) continue;
    const code = entries.get(name);
    if (code === undefined) continue;
    selectedNames.add(name);

    for (const token of code.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\b/g)) {
      const dependency = token[0];
      if (allNames.has(dependency) && !selectedNames.has(dependency)) {
        pending.push(dependency);
      }
    }
  }

  return new Map([...entries].filter(([name]) => selectedNames.has(name)));
}

function normalizeNullableTypes(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeNullableTypes(child),
  ]);
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<string, Schema.Json>;
  const typeValue = normalizedObject.type;

  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }
  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

function stripNullDefaults(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(stripNullDefaults);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "default" && child === null))
      .map(([key, child]) => [key, stripNullDefaults(child)]),
  ) as Schema.Json;
}

function schemaPropertyLiteral(value: Schema.Json, propertyName: string): string | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  const properties = (value as Readonly<Record<string, Schema.Json>>).properties;
  if (properties === null || Array.isArray(properties) || typeof properties !== "object") {
    return undefined;
  }
  const property = (properties as Readonly<Record<string, Schema.Json>>)[propertyName];
  if (property === null || Array.isArray(property) || typeof property !== "object") {
    return undefined;
  }
  const propertyObject = property as Readonly<Record<string, Schema.Json>>;
  if (typeof propertyObject.const === "string") {
    return propertyObject.const;
  }
  return Array.isArray(propertyObject.enum) &&
    propertyObject.enum.length === 1 &&
    typeof propertyObject.enum[0] === "string"
    ? propertyObject.enum[0]
    : undefined;
}

function isUnsupportedPluginSource(value: Schema.Json): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const object = value as Readonly<Record<string, Schema.Json>>;
  const sourceType = schemaPropertyLiteral(value, "type");
  return (
    typeof object.title === "string" &&
    object.title.endsWith("PluginSource") &&
    sourceType !== undefined &&
    !PLUGIN_SOURCE_TYPES.has(sourceType)
  );
}

function projectProtocolSchema(
  value: Schema.Json,
  context: {
    readonly thread?: boolean;
    readonly codexErrorInfo?: boolean;
    readonly propertyMap?: boolean;
  } = {},
): Schema.Json {
  if (Array.isArray(value)) {
    return value
      .filter(
        (entry) =>
          !isUnsupportedPluginSource(entry) &&
          (!context.codexErrorInfo ||
            typeof entry !== "string" ||
            CODEX_ERROR_INFO_VALUES.has(entry)),
      )
      .map((entry) => projectProtocolSchema(entry, context));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value)
    .filter(([key]) => context.propertyMap || key !== "description")
    .map(([key, child]) => {
      if (
        key === "properties" &&
        context.thread &&
        child !== null &&
        !Array.isArray(child) &&
        typeof child === "object"
      ) {
        const properties = Object.fromEntries(
          Object.entries(child).filter(([propertyName]) => THREAD_PROPERTIES.has(propertyName)),
        ) as Schema.Json;
        return [key, projectProtocolSchema(properties, { propertyMap: true })] as const;
      }
      if (key === "required" && context.thread && Array.isArray(child)) {
        return [key, child.filter((entry) => THREAD_PROPERTIES.has(String(entry)))] as const;
      }
      return [
        key,
        projectProtocolSchema(child, {
          ...(context.codexErrorInfo ? { codexErrorInfo: true } : {}),
          ...(key === "properties" ? { propertyMap: true } : {}),
        }),
      ] as const;
    });
  return Object.fromEntries(entries) as Schema.Json;
}

function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

function parseRequestEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params:\s*([^,}]+)/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      paramsType: match[2]!.trim(),
    });
  }
  return entries;
}

function parseNotificationEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}

function resolveSchemaTypeName(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  if (rawTypeName === "undefined") {
    return "undefined";
  }

  const candidates = [
    rawTypeName,
    `V2${rawTypeName}`,
    `V1${rawTypeName}`,
    `SerdeJson${rawTypeName}`,
  ];
  for (const candidate of candidates) {
    if (generatedSchemaNames.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve schema type name: ${rawTypeName}`);
}

function resolveResponseTypeName(
  method: string,
  paramsType: string | undefined,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const overrides: Record<string, string> = {
    "config/mcpServer/reload": "McpServerRefreshResponse",
  };

  const override = overrides[method];
  if (override) {
    return resolveSchemaTypeName(override, generatedSchemaNames);
  }

  if (paramsType && paramsType !== "undefined") {
    const fromParams = paramsType.replace(/Params$/, "Response");
    try {
      return resolveSchemaTypeName(fromParams, generatedSchemaNames);
    } catch {
      // Fall through to method-based lookup.
    }
  }

  return resolveSchemaTypeName(`${toPascalCaseMethod(method)}Response`, generatedSchemaNames);
}

function renderMethodConstants(constantName: string, entries: ReadonlyArray<MethodEntry>) {
  return [
    `export const ${constantName} = {`,
    ...entries.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${JSON.stringify(entry.method)},`,
    ),
    "} as const;",
    "",
  ].join("\n");
}

function renderTypeInterface(
  interfaceName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export interface ${interfaceName} {`,
    ...entries.map((entry) => `  readonly ${JSON.stringify(entry.method)}: ${typeName(entry)};`),
    "}",
    "",
  ].join("\n");
}

function renderSchemaMap(
  constantName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export const ${constantName} = {`,
    ...entries.map((entry) => {
      const schemaName = typeName(entry);
      return `  ${JSON.stringify(entry.method)}: ${
        schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`
      },`;
    }),
    "} as const;",
    "",
  ].join("\n");
}

function renderSchemaTypeReference(schemaName: string) {
  return schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`;
}

function exportNameForPath(filePath: string): string {
  const relative = filePath.replace(/^schema\/json\//, "").replace(/\.json$/, "");
  if (!relative.includes("/")) {
    return relative;
  }

  const [namespace, name] = relative.split("/", 2) as [string, string];
  const namespacePrefix = namespace
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
  return `${namespacePrefix}${name}`;
}

function buildJsonSchemaFiles(
  entries: ReadonlyArray<GithubContentEntry>,
): ReadonlyArray<JsonSchemaFile> {
  return entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.name.endsWith(".json") &&
        entry.download_url !== null &&
        !entry.name.startsWith("codex_app_server_protocol."),
    )
    .map((entry) => {
      const relative = entry.path.replace(/^codex-rs\/app-server-protocol\/schema\/json\//, "");
      const parts = relative.split("/");
      if (parts.length > 1) {
        return {
          namespace: parts[0]!,
          exportName: exportNameForPath(relative),
          fileName: entry.name,
          downloadUrl: entry.download_url!,
          qualifiedName: relative.replace(/\.json$/, ""),
        } satisfies JsonSchemaFile;
      }
      return {
        exportName: exportNameForPath(relative),
        fileName: entry.name,
        downloadUrl: entry.download_url!,
        qualifiedName: relative.replace(/\.json$/, ""),
      } satisfies JsonSchemaFile;
    });
}

function rewriteExternalRefs(
  value: Schema.Json,
  localDefinitionNames: ReadonlyMap<string, string>,
  currentNamespace: string | undefined,
  exportNameByQualifiedName: ReadonlyMap<string, string>,
): Schema.Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rewriteExternalRefs(entry, localDefinitionNames, currentNamespace, exportNameByQualifiedName),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")) {
        const definitionName = child.slice("#/definitions/".length);
        const localRewrite = localDefinitionNames.get(definitionName);
        if (localRewrite) {
          return [key, `#/definitions/${localRewrite}`];
        }

        const candidates = [
          ...(currentNamespace ? [`${currentNamespace}/${definitionName}`] : []),
          definitionName,
          definitionName.replace(/^v[12]\//, ""),
          definitionName.replace(/^serde_json\//, ""),
          `v2/${definitionName}`,
          `v1/${definitionName}`,
          `serde_json/${definitionName}`,
        ];

        const rewritten = candidates
          .map((candidate) => exportNameByQualifiedName.get(candidate))
          .find((candidate) => candidate !== undefined);

        if (!rewritten) {
          throw new Error(`Missing rewritten definition for ref: ${child}`);
        }

        return [key, `#/definitions/${rewritten}`];
      }

      return [
        key,
        rewriteExternalRefs(
          child,
          localDefinitionNames,
          currentNamespace,
          exportNameByQualifiedName,
        ),
      ];
    }),
  ) as Schema.Json;
}

const generateFiles = Effect.fn("generateFiles")(function* () {
  yield* ensureGeneratedDir();

  const [rootJsonEntries, v1JsonEntries, v2JsonEntries] = yield* Effect.all([
    fetchDirectoryEntries("schema/json"),
    fetchDirectoryEntries("schema/json/v1"),
    fetchDirectoryEntries("schema/json/v2"),
  ]);

  const jsonSchemaFiles = [
    ...buildJsonSchemaFiles(rootJsonEntries),
    ...buildJsonSchemaFiles(v1JsonEntries),
    ...buildJsonSchemaFiles(v2JsonEntries),
  ].toSorted((left, right) => left.exportName.localeCompare(right.exportName));

  const exportNameByQualifiedName = new Map(
    jsonSchemaFiles.map((file) => [file.qualifiedName, file.exportName]),
  );
  const aggregateSchemas: Record<string, Schema.Json> = {};

  for (const file of jsonSchemaFiles) {
    const raw = yield* fetchText(file.downloadUrl);
    const parsed = yield* decodeJsonSchemaDocument(raw);
    const localDefinitionNames = new Map(
      Object.keys(parsed.definitions ?? {}).map((definitionName) => [
        definitionName,
        `${file.exportName}__${definitionName.replace(/[^A-Za-z0-9]/g, "")}`,
      ]),
    );

    for (const [definitionName, definitionSchema] of Object.entries(parsed.definitions ?? {})) {
      const compatibleDefinitionSchema =
        Codex0150DefinitionSchemas[definitionName] ?? definitionSchema;
      aggregateSchemas[localDefinitionNames.get(definitionName)!] = stripNullDefaults(
        normalizeNullableTypes(
          projectProtocolSchema(
            rewriteExternalRefs(
              compatibleDefinitionSchema,
              localDefinitionNames,
              file.namespace,
              exportNameByQualifiedName,
            ),
            {
              ...(definitionName === "Thread" ? { thread: true } : {}),
              ...(definitionName === "CodexErrorInfo" ? { codexErrorInfo: true } : {}),
            },
          ),
        ),
      );
    }

    const topLevelSchema: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== "definitions") {
        topLevelSchema[key] = value;
      }
    }

    aggregateSchemas[file.exportName] = stripNullDefaults(
      normalizeNullableTypes(
        projectProtocolSchema(
          rewriteExternalRefs(
            topLevelSchema,
            localDefinitionNames,
            file.namespace,
            exportNameByQualifiedName,
          ),
        ),
      ),
    );
  }

  for (const [name, schema] of Object.entries(ManualSchemas)) {
    if (!(name in aggregateSchemas)) {
      aggregateSchemas[name] = stripNullDefaults(normalizeNullableTypes(schema));
    }
  }

  const generator = makeJsonSchemaGenerator();
  for (const [name, schema] of Object.entries(aggregateSchemas).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    generator.addSchema(name, schema as never);
  }

  const allGeneratedEntries = new Map<string, string>();
  const output = generator.generate("openapi-3.1", aggregateSchemas as never, false).trim();
  if (output.length > 0) {
    for (const entry of collectSchemaEntries(output)) {
      if (!allGeneratedEntries.has(entry.name)) {
        allGeneratedEntries.set(entry.name, entry.code);
      }
    }
  }

  const allGeneratedSchemaNames = new Set(allGeneratedEntries.keys());
  const clientRequestRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts`,
  );
  const clientNotificationRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ClientNotification.ts`,
  );
  const serverRequestRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts`,
  );
  const serverNotificationRaw = yield* fetchText(
    `https://raw.githubusercontent.com/openai/codex/${UPSTREAM_REF}/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts`,
  );

  const clientRequestEntries = parseRequestEntries(clientRequestRaw).filter((entry) =>
    CLIENT_REQUEST_METHODS.has(entry.method),
  );
  const clientNotificationEntries = parseNotificationEntries(clientNotificationRaw).filter(
    (entry) => CLIENT_NOTIFICATION_METHODS.has(entry.method),
  );
  const serverRequestEntries = parseRequestEntries(serverRequestRaw).filter((entry) =>
    SERVER_REQUEST_METHODS.has(entry.method),
  );
  const serverNotificationEntries = parseNotificationEntries(serverNotificationRaw).filter(
    (entry) => SERVER_NOTIFICATION_METHODS.has(entry.method),
  );

  const schemaRoots = new Set(APP_SCHEMA_ROOTS);
  const addSchemaRoot = (name: string) => {
    if (name !== "undefined") schemaRoots.add(name);
  };
  for (const entry of clientRequestEntries) {
    addSchemaRoot(resolveSchemaTypeName(entry.paramsType ?? "undefined", allGeneratedSchemaNames));
    addSchemaRoot(resolveResponseTypeName(entry.method, entry.paramsType, allGeneratedSchemaNames));
  }
  for (const entry of clientNotificationEntries) {
    addSchemaRoot(resolveSchemaTypeName(entry.paramsType ?? "undefined", allGeneratedSchemaNames));
  }
  for (const entry of serverRequestEntries) {
    addSchemaRoot(resolveSchemaTypeName(entry.paramsType ?? "undefined", allGeneratedSchemaNames));
    addSchemaRoot(resolveResponseTypeName(entry.method, entry.paramsType, allGeneratedSchemaNames));
  }
  for (const entry of serverNotificationEntries) {
    addSchemaRoot(resolveSchemaTypeName(entry.paramsType ?? "undefined", allGeneratedSchemaNames));
  }

  const generatedEntries = selectReachableSchemaEntries(allGeneratedEntries, schemaRoots);
  const generatedSchemaNames = new Set(generatedEntries.keys());

  const prelude = [
    "// This file is generated by the effect-codex-app-server package. Do not edit manually.",
    `// Upstream protocol ref: ${UPSTREAM_REF}`,
    "",
  ];

  const schemaOutput = [
    ...prelude,
    'import * as Schema from "effect/Schema";',
    "",
    [...generatedEntries.values()].join("\n\n"),
    "",
  ].join("\n");

  const metaOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    renderMethodConstants("CLIENT_REQUEST_METHODS", clientRequestEntries),
    renderMethodConstants("CLIENT_NOTIFICATION_METHODS", clientNotificationEntries),
    renderMethodConstants("SERVER_REQUEST_METHODS", serverRequestEntries),
    renderMethodConstants("SERVER_NOTIFICATION_METHODS", serverNotificationEntries),
    "export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;",
    "export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;",
    "export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;",
    "export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;",
    "",
    renderTypeInterface("ClientRequestParamsByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientRequestResponsesByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientNotificationParamsByMethod", clientNotificationEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerRequestParamsByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerRequestResponsesByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerNotificationParamsByMethod", serverNotificationEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderSchemaMap("CLIENT_REQUEST_PARAMS", clientRequestEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_REQUEST_RESPONSES", clientRequestEntries, (entry) =>
      resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_NOTIFICATION_PARAMS", clientNotificationEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_PARAMS", serverRequestEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_RESPONSES", serverRequestEntries, (entry) =>
      resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_NOTIFICATION_PARAMS", serverNotificationEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
  ].join("\n");

  const namespaceGroups = new Map<string, Array<JsonSchemaFile>>();
  for (const file of jsonSchemaFiles) {
    if (!file.namespace || !generatedSchemaNames.has(file.exportName)) {
      continue;
    }
    const current = namespaceGroups.get(file.namespace) ?? [];
    current.push(file);
    namespaceGroups.set(file.namespace, current);
  }

  const namespacesOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    ...[...namespaceGroups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([namespace, files]) => {
        const constantName = namespace.replace(/[^A-Za-z0-9]/g, "");
        return [
          `export const ${constantName} = {`,
          ...files
            .toSorted((left, right) => left.fileName.localeCompare(right.fileName))
            .map(
              (file) =>
                `  ${JSON.stringify(file.fileName.replace(/\.json$/, ""))}: CodexSchema.${file.exportName},`,
            ),
          "} as const;",
          "",
        ].join("\n");
      }),
  ].join("\n");

  const fs = yield* FileSystem.FileSystem;
  const { generatedDir, metaOutputPath, namespacesOutputPath, schemaOutputPath } =
    yield* getGeneratedPaths();
  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
  yield* fs.writeFileString(namespacesOutputPath, namespacesOutput);

  yield* Effect.log(`Generated Codex App Server schemas from ${UPSTREAM_REF}`);

  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(ChildProcess.make("vp", ["fmt", generatedDir, "--write"])),
    ),
    Effect.flatMap((child) => child.exitCode),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new GeneratorError({
              detail: `vp fmt failed with exit code ${code}`,
            }),
          ),
    ),
  );
});

generateFiles().pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Logger.layer([Logger.consolePretty()]),
      NodeServices.layer,
      FetchHttpClient.layer,
    ),
  ),
  NodeRuntime.runMain,
);
