import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  KeybindingsConfig,
  KeybindingRule,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const decodeResolvedRule = Schema.decodeUnknownEffect(ResolvedKeybindingRule as never);
const encodeResolvedKeybindings = Schema.encodeEffect(ResolvedKeybindingsConfig);

it.effect("parses keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+j",
      command: "rightPanel.toggle",
    });
    assert.strictEqual(parsed.command, "rightPanel.toggle");

    const parsedSidebarToggle = yield* decode(KeybindingRule, {
      key: "mod+b",
      command: "sidebar.toggle",
    });
    assert.strictEqual(parsedSidebarToggle.command, "sidebar.toggle");

    const parsedRightPanelToggle = yield* decode(KeybindingRule, {
      key: "mod+alt+b",
      command: "rightPanel.toggle",
    });
    assert.strictEqual(parsedRightPanelToggle.command, "rightPanel.toggle");

    const parsedRightPanelToggleMaximized = yield* decode(KeybindingRule, {
      key: "mod+shift+m",
      command: "rightPanel.toggleMaximized",
    });
    assert.strictEqual(parsedRightPanelToggleMaximized.command, "rightPanel.toggleMaximized");

    const parsedClose = yield* decode(KeybindingRule, {
      key: "mod+w",
      command: "rightPanel.toggle",
    });
    assert.strictEqual(parsedClose.command, "rightPanel.toggle");

    const parsedCommandPalette = yield* decode(KeybindingRule, {
      key: "mod+k",
      command: "commandPalette.toggle",
    });
    assert.strictEqual(parsedCommandPalette.command, "commandPalette.toggle");

    const parsedFilePicker = yield* decode(KeybindingRule, {
      key: "mod+p",
      command: "filePicker.toggle",
    });
    assert.strictEqual(parsedFilePicker.command, "filePicker.toggle");

    const parsedProjectSearch = yield* decode(KeybindingRule, {
      key: "mod+shift+f",
      command: "projectSearch.toggle",
    });
    assert.strictEqual(parsedProjectSearch.command, "projectSearch.toggle");

    const parsedNewChat = yield* decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "chat.new",
    });
    assert.strictEqual(parsedNewChat.command, "chat.new");

    const parsedModelPickerToggle = yield* decode(KeybindingRule, {
      key: "mod+shift+m",
      command: "modelPicker.toggle",
    });
    assert.strictEqual(parsedModelPickerToggle.command, "modelPicker.toggle");

    const parsedModelPickerJump = yield* decode(KeybindingRule, {
      key: "mod+1",
      command: "modelPicker.jump.1",
    });
    assert.strictEqual(parsedModelPickerJump.command, "modelPicker.jump.1");

    const parsedThreadPrevious = yield* decode(KeybindingRule, {
      key: "mod+shift+[",
      command: "thread.previous",
    });
    assert.strictEqual(parsedThreadPrevious.command, "thread.previous");
  }),
);

it.effect("rejects invalid command values", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(KeybindingRule, {
        key: "mod+j",
        command: "unknown.command",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("parses keybindings array payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingsConfig, [
      { key: "mod+j", command: "rightPanel.toggle" },
      { key: "mod+d", command: "preview.toggle", when: "modelPickerOpen" },
      { key: "mod+shift+d", command: "rightPanel.toggleMaximized", when: "modelPickerOpen" },
    ]);
    assert.lengthOf(parsed, 3);
  }),
);

it.effect("parses resolved keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingRule, {
      command: "preview.toggle",
      shortcut: {
        key: "d",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "previewOpen" },
        right: {
          type: "not",
          node: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    assert.strictEqual(parsed.shortcut.key, "d");
  }),
);

it.effect("parses resolved keybindings arrays", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "rightPanel.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
      {
        command: "thread.jump.3",
        shortcut: {
          key: "3",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "rightPanel.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "filePicker.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["rightPanel.toggle", "filePicker.toggle"],
    );
  }),
);

it.effect("drops resolved rules with unknown when-node types", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "rightPanel.toggle",
        shortcut,
        whenAst: { type: "xor", left: 1, right: 2 },
      },
      { command: "preview.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["preview.toggle"],
    );
  }),
);

it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      { command: "rightPanel.toggle", shortcut },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["rightPanel.toggle"],
    );
  }),
);

it.effect("encodes resolved keybindings to the plain wire shape", () =>
  Effect.gen(function* () {
    const rules = [{ command: "rightPanel.toggle" as const, shortcut }];
    const encoded = yield* encodeResolvedKeybindings(rules);
    assert.deepEqual(encoded, rules);
    const roundTripped = yield* decode(ResolvedKeybindingsConfig, encoded);
    assert.deepEqual(roundTripped, rules);
  }),
);

it.effect("drops unknown fields in resolved keybinding rules", () =>
  decodeResolvedRule({
    command: "rightPanel.toggle",
    shortcut: {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    key: "mod+j",
  }).pipe(
    Effect.map((parsed) => {
      const view = parsed as Record<string, unknown>;
      assert.strictEqual("key" in view, false);
      assert.strictEqual(view.command, "rightPanel.toggle");
    }),
  ),
);
