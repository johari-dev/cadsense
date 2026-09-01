import { assert, it } from "@effect/vitest";

import {
  assetResponseHeaders,
  downloadContentDisposition,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

it("recognizes only loopback hosts as local", () => {
  assert.isTrue(isLoopbackHostname("localhost"));
  assert.isTrue(isLoopbackHostname("127.0.0.1"));
  assert.isTrue(isLoopbackHostname("::1"));
  assert.isFalse(isLoopbackHostname("192.168.1.50"));
  assert.isFalse(isLoopbackHostname("example.com"));
});

it("keeps development redirects on the configured local renderer", () => {
  const target = resolveDevRedirectUrl(
    new URL("http://localhost:5173/base/"),
    new URL("http://localhost:3773/projects/demo?tab=chat"),
  );

  assert.strictEqual(target, "http://localhost:5173/projects/demo?tab=chat");
});

it("builds safe attachment response headers", () => {
  assert.strictEqual(
    downloadContentDisposition('report "one".txt'),
    'attachment; filename="report _one_.txt"',
  );
  const headers = assetResponseHeaders("/tmp/report.txt", {
    download: true,
    fileName: "report.txt",
    mimeType: "text/plain",
  });
  assert.strictEqual(headers["Content-Disposition"], 'attachment; filename="report.txt"');
  assert.strictEqual(headers["Content-Type"], "text/plain");
  assert.strictEqual(headers["X-Content-Type-Options"], "nosniff");
});
