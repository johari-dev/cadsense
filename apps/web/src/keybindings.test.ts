import { assert, describe, it } from "vite-plus/test";

import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@cadsense/contracts";
import {
  formatShortcutLabel,
  isChatNewShortcut,
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(key: string): KeybindingShortcut {
  return {
    key,
    modKey: true,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
}

function binding(command: KeybindingCommand, key: string): ResolvedKeybindingsConfig[number] {
  return { command, shortcut: modShortcut(key) };
}

describe("keybindings", () => {
  const keybindings: ResolvedKeybindingsConfig = [
    binding("rightPanel.toggle", "j"),
    binding("chat.new", "n"),
  ];

  it("resolves the platform modifier", () => {
    assert.equal(
      resolveShortcutCommand(event({ key: "j", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "rightPanel.toggle",
    );
    assert.equal(
      resolveShortcutCommand(event({ key: "j", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "rightPanel.toggle",
    );
  });

  it("matches retained application commands", () => {
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, { platform: "Linux" }),
    );
  });

  it("formats shortcut labels", () => {
    assert.equal(formatShortcutLabel(modShortcut("j"), "MacIntel"), "⌘J");
    assert.equal(shortcutLabelForCommand(keybindings, "chat.new", "Linux"), "Ctrl+N");
  });

  it("maps thread and model-picker jump commands", () => {
    assert.equal(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.equal(threadJumpIndexFromCommand("thread.jump.9"), 8);
    assert.equal(threadJumpIndexFromCommand("chat.new"), null);
    assert.equal(modelPickerJumpCommandForIndex(1), "modelPicker.jump.2");
    assert.equal(modelPickerJumpIndexFromCommand("modelPicker.jump.2"), 1);
  });

  it("maps thread traversal commands", () => {
    assert.equal(threadTraversalDirectionFromCommand("thread.previous"), "previous");
    assert.equal(threadTraversalDirectionFromCommand("thread.next"), "next");
    assert.equal(threadTraversalDirectionFromCommand("chat.new"), null);
  });
});
