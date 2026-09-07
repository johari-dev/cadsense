import {
  CAD_CAPTURE_SIZE,
  CadRenderPayload,
  type CadRenderEvent,
  type CadRenderTicket,
} from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { createCadBrowserPool } from "./CadBrowserWorkers";
import { CadRendererError } from "./CadRendererError";
import { cadDiagnostics } from "./CadDiagnostics";
import { isCadMemoryConstrained } from "./CadMemoryPolicy";
const decodePayload = Schema.decodeUnknownSync(CadRenderPayload);

/** The host outlives routed threads. Only two jobs may load manifests or render at once. */
export const createCadRenderHost = (baseUrl: string) => {
  const diagnostics = cadDiagnostics.register();
  const jobs = new Map<
    string,
    { ticket: CadRenderTicket; controller: AbortController; snapshotId?: string; runId?: string }
  >();
  const queued: CadRenderTicket[] = [];
  let running = 0;
  let disposed = false;
  const url = (ticket: CadRenderTicket, hash?: string) =>
    new URL(
      `api/cad-render/${ticket.jobId}${hash ? `/${hash}` : ""}`,
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    );
  const request = async (ticket: CadRenderTicket, init: RequestInit = {}, hash?: string) => {
    const response = await fetch(url(ticket, hash), {
      ...init,
      headers: { ...init.headers, "x-cad-render-token": ticket.token },
      credentials: "omit",
    });
    if (!response.ok) throw new CadRendererError("capture-failed");
    return response;
  };
  const pool = createCadBrowserPool({
    onDiagnostic: diagnostics.record,
    onRendererDiagnostic: diagnostics.record,
    isCurrent: (job) => !disposed && jobs.has(job.jobId),
    readAsset: async (snapshotId, hash, signal) => {
      const owner = [...jobs.values()].find(
        (item) => item.snapshotId === snapshotId && !item.controller.signal.aborted,
      );
      if (!owner) throw new CadRendererError("superseded");
      return (await request(owner.ticket, { signal }, hash)).arrayBuffer();
    },
  });
  const updatePolicy = () =>
    pool.setPolicy({
      backgrounded: document.hidden,
      memoryPressure: isCadMemoryConstrained(
        typeof navigator === "undefined" ? undefined : Reflect.get(navigator, "deviceMemory"),
        Reflect.get(performance, "memory"),
      ),
    });
  document.addEventListener("visibilitychange", updatePolicy);
  updatePolicy();
  const run = async (ticket: CadRenderTicket) => {
    const item = jobs.get(ticket.jobId);
    if (!item) return;
    try {
      const payload = decodePayload(
        await (await request(ticket, { signal: item.controller.signal })).json(),
      );
      if (item.controller.signal.aborted) return;
      item.snapshotId = payload.state.snapshotId;
      item.runId = payload.runId;
      const result = await pool.capture(
        { jobId: ticket.jobId, ...payload, ...CAD_CAPTURE_SIZE },
        item.controller.signal,
      );
      await request(ticket, {
        method: "POST",
        signal: item.controller.signal,
        body: result.png,
        headers: {
          "content-type": "image/png",
          "x-cad-render-receipt": JSON.stringify({
            snapshotId: result.snapshotId,
            revision: result.revision,
            pose: result.pose,
          }),
        },
      });
    } catch {
      if (!disposed && !item.controller.signal.aborted)
        await request(ticket, { method: "DELETE", signal: item.controller.signal }).catch(
          () => undefined,
        );
    } finally {
      jobs.delete(ticket.jobId);
    }
  };
  const pump = () => {
    if (disposed) return;
    while (running < 2 && queued.length > 0) {
      const ticket = queued.shift()!;
      if (!jobs.has(ticket.jobId)) continue;
      running++;
      void run(ticket).finally(() => {
        running--;
        pump();
      });
    }
  };
  return {
    accept: (event: CadRenderEvent) => {
      if (disposed || event.type === "ready") return;
      updatePolicy();
      if (event.type === "run-ended") {
        for (const [id, item] of jobs) {
          if (item.runId !== event.runId) continue;
          item.controller.abort();
          jobs.delete(id);
        }
        pool.endRun(event.runId);
        return;
      }
      if (event.type === "cancel") {
        jobs.get(event.jobId)?.controller.abort();
        jobs.delete(event.jobId);
        const index = queued.findIndex((ticket) => ticket.jobId === event.jobId);
        if (index >= 0) queued.splice(index, 1);
        return;
      }
      if (jobs.has(event.ticket.jobId)) return;
      if (jobs.size >= 64) {
        void request(event.ticket, { method: "DELETE" }).catch(() => undefined);
        return;
      }
      jobs.set(event.ticket.jobId, { ticket: event.ticket, controller: new AbortController() });
      queued.push(event.ticket);
      pump();
    },
    dispose: () => {
      disposed = true;
      document.removeEventListener("visibilitychange", updatePolicy);
      for (const item of jobs.values()) item.controller.abort();
      jobs.clear();
      queued.length = 0;
      pool.dispose();
      diagnostics.dispose();
    },
  };
};
