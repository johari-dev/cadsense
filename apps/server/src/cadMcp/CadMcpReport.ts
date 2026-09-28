import { CadComment, type ThreadId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readThreadCadComments } from "../cad/CadCommentPersistence.ts";
import { cadCommentEvidenceDirectory } from "../cad/CadComments.ts";
import { ServerConfig } from "../config.ts";

export interface CadMcpReportInput {
  readonly threadId: ThreadId;
  readonly directory: string;
  readonly title: string;
  readonly sourceUrl: string;
}

const encodeComments = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(CadComment)));
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const renderTarget = (target: CadComment["targets"][number]) =>
  target.kind === "point"
    ? `<figure><img src="images/${escape(target.inspectionId)}.png" alt=""><figcaption>${escape(target.label)}. Checked from another angle: ${escape(target.confirmationReason)}</figcaption></figure>`
    : `<p class="part">${escape(target.label)}, whole part. ${escape(target.preciseLocationLimitation)}</p>`;

const renderComment = (comment: CadComment) => `<section>
<h2>${comment.number}. ${escape(comment.title)}</h2>
<p class="meta">${escape(comment.state)} · ${escape(comment.createdAt)}</p>
<p>${escape(comment.body)}</p>
${comment.targets.map(renderTarget).join("\n")}
</section>`;

/**
 * Writes `index.html` and `comments.json` for one MCP review, copying each verified location's
 * numbered inspection image beside them. `cadsense mcp` rewrites it after every publication, so
 * an unattended run always leaves a current report even when nobody opens Cadsense.
 */
export const writeCadMcpReport = Effect.fn("writeCadMcpReport")(function* (
  input: CadMcpReportInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  // Comments from one publication share a sequence and fall back to ID order; readers expect numbers.
  const comments = (yield* readThreadCadComments(input.threadId).pipe(
    Effect.provideService(SqlClient.SqlClient, yield* SqlClient.SqlClient),
  )).toSorted((left, right) => left.number - right.number);
  const images = path.join(input.directory, "images");
  yield* fs.makeDirectory(images, { recursive: true });
  const evidence = cadCommentEvidenceDirectory(path, config.stateDir, input.threadId);
  for (const comment of comments)
    for (const target of comment.targets)
      if (target.kind === "point")
        yield* fs
          .copyFile(
            path.join(evidence, `${target.inspectionId}.png`),
            path.join(images, `${target.inspectionId}.png`),
          )
          .pipe(Effect.catch(() => Effect.logWarning("CAD review image is missing", { target })));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(input.title)}</title>
<style>
body { background: #000; color: #fff; font: 14px/1.5 system-ui, sans-serif; margin: 24px; max-width: 1320px; }
a { color: #fff; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 32px 0 4px; }
.meta, figcaption, .part { color: #bbb; }
img { display: block; max-width: 100%; border: 1px solid #333; }
figure { margin: 12px 0; }
</style>
</head>
<body>
<h1>${escape(input.title)}</h1>
<p class="meta"><a href="${escape(input.sourceUrl)}">${escape(input.sourceUrl)}</a> · ${comments.length} ${comments.length === 1 ? "comment" : "comments"}</p>
${comments.length === 0 ? "<p>No comments published yet.</p>" : comments.map(renderComment).join("\n")}
</body>
</html>
`;
  yield* fs.writeFileString(
    path.join(input.directory, "comments.json"),
    yield* encodeComments(comments),
  );
  const file = path.join(input.directory, "index.html");
  yield* fs.writeFileString(file, html);
  return file;
});
