import { describe, expect, it } from "vite-plus/test";
import type { ResolvedKeybindingsConfig } from "@cadsense/contracts";

import {
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  unknownWhenVariables,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";

describe("KeybindingsSettings.logic", () => {
  it("builds searchable rows with readable key and when values", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "rightPanel.toggle",
          shortcut: {
            key: "j",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "modelPickerOpen" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "custom",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        command: "rightPanel.toggle",
        key: "mod+j",
        when: "!modelPickerOpen",
        defaultKey: "mod+alt+b",
        defaultWhen: "",
        source: "Custom",
      }),
    ]);
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it("serializes shortcuts and when expressions for upserts", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "modelPickerOpen" },
        },
      }),
    ).toBe("editorFocus && !modelPickerOpen");

    expect(
      parseWhenExpressionDraft("editorFocus && (!modelPickerOpen || modelPickerOpen)"),
    ).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "or",
          left: {
            type: "not",
            node: { type: "identifier", name: "modelPickerOpen" },
          },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("editorFocus &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });

    expect(parseWhenExpressionDraft("!(modelPickerOpen || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "not",
        node: {
          type: "or",
          left: { type: "identifier", name: "modelPickerOpen" },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
  });

  it("formats command labels", () => {
    expect(commandLabel("commandPalette.toggle")).toBe("Command Palette: Toggle");
    expect(commandLabel("preview.toggle")).toBe("Preview: Toggle");
  });

  it("builds known when variable options from defaults without frontend labels", () => {
    const options = buildWhenVariableOptions();

    expect(options).toEqual(
      expect.arrayContaining(["modelPickerOpen", "previewFocus", "true", "false"]),
    );
    expect(options).not.toContain("customModeActive");
  });

  it("builds command options from built-in commands", () => {
    const options = buildKeybindingCommandOptions([]);

    expect(options).toEqual(expect.arrayContaining(["chat.new", "rightPanel.toggleMaximized"]));
  });

  it("reports unknown when variables without rejecting parseable expressions", () => {
    const parsed = parseWhenExpressionDraft("!modelPickerOpen && modelPickerOpe");

    expect(parsed.ok).toBe(true);
    expect(unknownWhenVariables(parsed.ok ? parsed.value : undefined)).toEqual(["modelPickerOpe"]);
  });

  it("marks each default shortcut for multi-binding commands as default", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
        },
        {
          command: "chat.new",
          shortcut: {
            key: "o",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows.map((row) => row.source)).toEqual(["Default", "Default"]);
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "modelPickerOpen" },
          },
        },
        {
          command: "preview.toggle",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "modelPickerOpen" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows[0]?.conflicts).toEqual(["Preview: Toggle"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["Preview: Toggle"]);
  });
});
