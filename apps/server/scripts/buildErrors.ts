import * as Schema from "effect/Schema";

export class ServerBuildCommandExitError extends Schema.TaggedErrorClass<ServerBuildCommandExitError>()(
  "ServerBuildCommandExitError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `Command exited with non-zero exit code (${this.exitCode})`;
  }
}

export class ServerBuildDevelopmentIconSourceMissingError extends Schema.TaggedErrorClass<ServerBuildDevelopmentIconSourceMissingError>()(
  "ServerBuildDevelopmentIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon source: ${this.sourcePath}`;
  }
}

export class ServerBuildDevelopmentIconTargetMissingError extends Schema.TaggedErrorClass<ServerBuildDevelopmentIconTargetMissingError>()(
  "ServerBuildDevelopmentIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon target: ${this.targetPath}. Build web first.`;
  }
}
