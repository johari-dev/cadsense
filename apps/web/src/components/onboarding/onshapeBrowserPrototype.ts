// Throwaway transport for the browser-import preview runner. The normal app does not
// install this flag or expose these endpoints.
import * as Schema from "effect/Schema";

declare global {
  interface Window {
    __cadsenseOnshapeBrowserPrototype?: boolean;
  }
}

const Download = Schema.Struct({ workspaceRoot: Schema.String, filePath: Schema.String });
const Job = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("failed"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("completed"), download: Download }),
]);
const decodeJob = Schema.decodeUnknownSync(Job);
const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ jobId: Schema.String }));
const decodeSource = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.NullOr(Schema.String) }));
const endpoint = "/__prototype/onshape-browser";

export function isOnshapeBrowserPrototype() {
  return typeof window !== "undefined" && window.__cadsenseOnshapeBrowserPrototype === true;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${endpoint}/${path}`, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "The Onshape browser could not start. Try again.");
  }
  return response.json();
}

export async function readOnshapeBrowserSource(workspaceRoot: string) {
  const result = await request(`source?workspaceRoot=${encodeURIComponent(workspaceRoot)}`);
  return decodeSource(result).url;
}

/** Acquire a complete STEP before the existing local-CAD commands import or sync it. */
export async function acquireOnshapeBrowserCad(
  input: { url: string; title: string } | { workspaceRoot: string },
  onProgress?: (message: string) => void,
) {
  const started = decodeStarted(
    await request("acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  const deadline = Date.now() + 450_000;
  while (Date.now() < deadline) {
    const job = decodeJob(await request(`jobs/${started.jobId}`));
    if (job.state === "completed") return job.download;
    if (job.state === "failed") throw new Error(job.message);
    onProgress?.(job.message);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error("The browser export timed out. Check the Onshape document and try again.");
}
