import { useCallback, useRef, useState } from "react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";

// The previews use the same font variables as the composer and code viewer.

const EMPTY_SKILLS: ReadonlyArray<never> = [];

// A request a Cadsense user would make. The @file mention renders as a chip, so the preview shows
// prompt text and pills exactly as the real composer draws them.
const PROMPT_PREVIEW_TEXT =
  "Check the clearance between the 40T gears and the motor plate in @elevator-cascade.step " +
  "and pin anything under 0.5 mm.";

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
        placeholder={COMPOSER_PLACEHOLDER}
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
      <code>{`// FeatureScript: the motor plate's bolt circle. 0O 1lI\nconst boltCircle = 1.875 * inch;\nopExtrude(context, id + "plate", { "depth" : 0.125 * inch });`}</code>
    </pre>
  );
}
