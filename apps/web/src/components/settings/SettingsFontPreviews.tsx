import { useCallback, useRef, useState } from "react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { DISCONNECTED_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";

// The previews use the same font variables as the composer and code viewer.

const EMPTY_SKILLS: ReadonlyArray<never> = [];

// Serialized the way the composer stores inline tokens: the /skill and the
// markdown-style file links render as chips, so the preview shows prompt
// text and pills exactly as the real composer draws them.
const PROMPT_PREVIEW_TEXT =
  "Use /frontend-design to improve " +
  "[Dashboard.tsx](src/components/Dashboard.tsx) and check the local preview before shipping.";

function noop() {}

/** A live composer editor: type in it to feel the family and size. */
export function PromptFontPreview() {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState(PROMPT_PREVIEW_TEXT);
  const [cursor, setCursor] = useState(PROMPT_PREVIEW_TEXT.length);
  const onChange = useCallback((nextValue: string, nextCursor: number) => {
    setPrompt(nextValue);
    setCursor(nextCursor);
  }, []);
  return (
    <div className="mt-1 mb-2 rounded-lg border border-border bg-background px-3 py-2">
      <ComposerPromptEditor
        editorRef={editorRef}
        value={prompt}
        cursor={cursor}
        skills={EMPTY_SKILLS}
        disabled={false}
        placeholder={DISCONNECTED_COMPOSER_PLACEHOLDER}
        className="max-h-40 min-h-12"
        onChange={onChange}
        onPaste={noop}
      />
    </div>
  );
}

export function CodeFontPreview() {
  return (
    <pre className="mt-1 mb-2 overflow-auto rounded-lg border border-border bg-code-background p-3 font-mono text-code-foreground">
      <code>{`export function formatUser(user: User) {\n  return \`${"${user.name}"} <${"${user.email}"}>\`; // 0O 1lI\n}`}</code>
    </pre>
  );
}
