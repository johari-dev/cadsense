import { describe, expect, it } from "vite-plus/test";

import { ThreadTitleGenerationError } from "./TextGeneration.ts";
import { buildThreadTitlePrompt } from "./TextGenerationPrompts.ts";
import { normalizeCliError, sanitizeThreadTitle } from "./TextGenerationUtils.ts";

describe("buildThreadTitlePrompt", () => {
  it("includes the initial message and attachment metadata", () => {
    const result = buildThreadTitlePrompt({
      message: "Investigate reconnect regressions",
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "thread.png",
          mimeType: "image/png",
          sizeBytes: 67890,
        },
      ],
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Investigate reconnect regressions");
    expect(result.prompt).toContain("thread.png (image/png, 67890 bytes)");
  });

  it("preserves the latest context when regenerating a title", () => {
    const result = buildThreadTitlePrompt({
      message: `${"old context ".repeat(1_000)}\n\nASSISTANT:\nCurrent thread state`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain('The previous title was "Old title".');
    expect(result.prompt).toContain("[Earlier content truncated]");
    expect(result.prompt).toContain("Current thread state");
  });
});

describe("sanitizeThreadTitle", () => {
  it("normalizes quotes, whitespace, and long titles", () => {
    expect(sanitizeThreadTitle('  "Reconnect failures"  ')).toBe("Reconnect failures");
    expect(
      sanitizeThreadTitle(
        "Reconnect failures after restart because the session state does not recover",
      ),
    ).toBe("Reconnect failures after restart because the se...");
  });

  it("uses a stable fallback for empty output", () => {
    expect(sanitizeThreadTitle('  """   """  ')).toBe("New thread");
  });
});

describe("normalizeCliError", () => {
  it("reports a missing provider CLI without exposing unrelated details", () => {
    const error = normalizeCliError(
      "codex",
      "generateThreadTitle",
      new Error("Command not found: codex"),
      "Title generation failed",
    );

    expect(error).toBeInstanceOf(ThreadTitleGenerationError);
    expect(error.operation).toBe("generateThreadTitle");
    expect(error.detail).toContain("not available on PATH");
  });

  it("preserves an already-normalized title error", () => {
    const existing = new ThreadTitleGenerationError({
      operation: "generateThreadTitle",
      detail: "Already wrapped",
    });

    expect(normalizeCliError("codex", "generateThreadTitle", existing, "fallback")).toBe(existing);
  });
});
