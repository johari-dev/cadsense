import { act, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AddConnectionForm } from "./OnshapeConnectionsSettings";
import type { OnshapeConnectionOperationSnapshot } from "./onshapeConnectionOperationStore";
import { OnshapeFieldError } from "./OnshapeFieldError";
import type { OnshapeConnectionEditor } from "./useOnshapeConnectionsController";
import { useOnshapeConnectionsFocus } from "./useOnshapeConnectionsFocus";

type Notice = OnshapeConnectionOperationSnapshot["notice"];
type Completion = OnshapeConnectionOperationSnapshot["completion"];

interface FocusHarnessProps {
  readonly connected?: boolean;
  readonly completion: Completion;
  readonly editor: OnshapeConnectionEditor;
  readonly notice: Notice;
  readonly showRemove: boolean;
}

class TestDomEvent {
  bubbles: boolean;
  cancelBubble = false;
  cancelable: boolean;
  currentTarget: TestNode | null = null;
  defaultPrevented = false;
  relatedTarget: TestNode | null = null;
  target: TestNode | null = null;

  constructor(
    readonly type: string,
    { bubbles = false, cancelable = false } = {},
  ) {
    this.bubbles = bubbles;
    this.cancelable = cancelable;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.cancelBubble = true;
  }
}

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/field", () => ({
  Field: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  FieldDescription: ({ children, ...props }: ComponentProps<"p">) => <p {...props}>{children}</p>,
  FieldLabel: ({ children, ...props }: ComponentProps<"label">) => (
    <label {...props}>{children}</label>
  ),
}));

vi.mock("../ui/input", () => ({
  Input: ({
    nativeInput: _nativeInput,
    ...props
  }: ComponentProps<"input"> & {
    readonly nativeInput?: boolean;
  }) => <input {...props} />,
}));

function FocusHarness({
  connected = true,
  completion,
  editor,
  notice,
  showRemove,
}: FocusHarnessProps) {
  const {
    addButtonRef,
    connectionContentRef,
    operationStatusRef,
    unavailableStatusRef,
    discardEditButtonRef,
  } = useOnshapeConnectionsFocus({
    connected,
    editor,
    operationNotice: notice,
    operationCompletion: completion,
    sectionId: "onshape-focus-test",
  });

  return (
    <section id="onshape-focus-test">
      {notice !== null ? (
        <div ref={operationStatusRef} tabIndex={-1} data-test-focus="status" />
      ) : null}
      {!connected ? (
        <div ref={unavailableStatusRef} tabIndex={-1} data-test-focus="unavailable">
          {editor !== null && notice === null ? (
            <button ref={discardEditButtonRef} type="button" data-test-focus="discard" />
          ) : null}
        </div>
      ) : null}
      {connected ? (
        <>
          <button ref={addButtonRef} type="button" data-test-focus="add" />
          <div ref={connectionContentRef}>
            {editor !== null ? <input data-test-focus="editor" /> : null}
            <button
              type="button"
              data-onshape-focus-key="rename:connection-1"
              data-test-focus="rename"
            />
            <button
              type="button"
              data-onshape-focus-key="replace:connection-1"
              data-test-focus="replace"
            />
            {showRemove ? (
              <button
                type="button"
                data-onshape-focus-key="remove:connection-1"
                data-test-focus="remove"
              />
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<
    string,
    Array<{ readonly capture: boolean; readonly listener: (event: TestDomEvent) => void }>
  >();
  disabled = false;
  nodeValue: string | null = null;
  value = "";

  constructor(
    name: string,
    readonly ownerDocument: TestDocument,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.nodeValue = value;
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: TestNode, before: TestNode | null) {
    child.parentNode = this;
    if (before === null) this.childNodes.push(child);
    else this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(
    name: string,
    listener: (event: TestDomEvent) => void,
    options?: boolean | { readonly capture?: boolean },
  ) {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const listeners = this.listeners.get(name) ?? [];
    listeners.push({ capture, listener });
    this.listeners.set(name, listeners);
  }

  removeEventListener(
    name: string,
    listener: (event: TestDomEvent) => void,
    options?: boolean | { readonly capture?: boolean },
  ) {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const listeners = this.listeners.get(name);
    if (listeners === undefined) return;
    this.listeners.set(
      name,
      listeners.filter((entry) => entry.listener !== listener || entry.capture !== capture),
    );
  }

  dispatchEvent(event: TestDomEvent) {
    event.target ??= this;
    const path: TestNode[] = [this];
    for (let parent = this.parentNode; parent !== null; parent = parent.parentNode) {
      path.push(parent);
    }
    const invoke = (node: TestNode, capture: boolean) => {
      event.currentTarget = node;
      for (const entry of node.listeners.get(event.type) ?? []) {
        if (entry.capture === capture) entry.listener(event);
        if (event.cancelBubble) return;
      }
    };
    for (const node of path.toReversed()) {
      invoke(node, true);
      if (event.cancelBubble) return !event.defaultPrevented;
    }
    for (const node of path) {
      invoke(node, false);
      if (!event.bubbles || event.cancelBubble) break;
    }
    return !event.defaultPrevented;
  }

  focus() {
    const previous = this.ownerDocument.activeElement;
    if (previous !== null) this.ownerDocument.dispatchFocusOut(previous, this);
    this.ownerDocument.activeElement = this;
    this.ownerDocument.dispatchFocusIn(this);
  }

  contains(candidate: TestNode | null): boolean {
    if (candidate === this) return true;
    return this.childNodes.some((child) => child.contains(candidate));
  }

  querySelector(selector: string): TestNode | null {
    return this.descendants().find((node) => node.matches(selector)) ?? null;
  }

  querySelectorAll(selector: string): TestNode[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  private descendants(): TestNode[] {
    return this.childNodes.flatMap((child) => [child, ...child.descendants()]);
  }

  private matches(selector: string): boolean {
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
    if (selector === "input:not(:disabled), button:not(:disabled)") {
      return (this.tagName === "INPUT" || this.tagName === "BUTTON") && !this.disabled;
    }
    const attribute = selector.match(/^\[([^=]+)="(.+)"\]$/);
    return attribute !== null && this.getAttribute(attribute[1] ?? "") === attribute[2];
  }
}

class TestDocument extends TestNode {
  activeElement: TestNode | null = null;
  private readonly focusInListeners = new Set<(event: TestDomEvent) => void>();
  private readonly focusOutListeners = new Set<(event: TestDomEvent) => void>();

  constructor() {
    super("#document", undefined as never, 9);
    Object.defineProperty(this, "ownerDocument", { value: this });
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createTextNode(value: string) {
    const node = new TestNode("#text", this, 3);
    node.nodeValue = value;
    return node;
  }

  override addEventListener(name: string, listener: (event: TestDomEvent) => void) {
    if (name === "focusin") this.focusInListeners.add(listener);
    else if (name === "focusout") this.focusOutListeners.add(listener);
    else super.addEventListener(name, listener);
  }

  override removeEventListener(name: string, listener: (event: TestDomEvent) => void) {
    if (name === "focusin") this.focusInListeners.delete(listener);
    else if (name === "focusout") this.focusOutListeners.delete(listener);
    else super.removeEventListener(name, listener);
  }

  dispatchFocusIn(target: TestNode) {
    const event = new TestDomEvent("focusin");
    event.target = target;
    for (const listener of this.focusInListeners) listener(event);
  }

  dispatchFocusOut(target: TestNode, relatedTarget: TestNode | null) {
    const event = new TestDomEvent("focusout");
    event.target = target;
    event.relatedTarget = relatedTarget;
    for (const listener of this.focusOutListeners) listener(event);
  }

  clearFocus() {
    const previous = this.activeElement;
    if (previous !== null) this.dispatchFocusOut(previous, null);
    this.activeElement = null;
  }

  getElementById(id: string) {
    return this.querySelectorById(id);
  }

  private querySelectorById(id: string): TestNode | null {
    const visit = (node: TestNode): TestNode | null => {
      if (node.getAttribute("id") === id) return node;
      for (const child of node.childNodes) {
        const match = visit(child);
        if (match !== null) return match;
      }
      return null;
    };
    return visit(this);
  }
}

function installTestDom() {
  const document = new TestDocument();
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("Node", TestNode);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

const pending = (key: string): Notice => ({ _tag: "Pending", key, message: "Working" });
const completed = (
  sequence: number,
  key: string,
  outcome: "Success" | "Interrupted" = "Success",
): Completion => ({ sequence, key, outcome });

describe("Onshape connection focus", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores the operation-specific control after rename, replacement, removal, and cancel", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.appendChild(container);
    const outside = document.createElement("button");
    outside.setAttribute("data-test-focus", "outside");
    document.appendChild(outside);
    const root = createRoot(container as unknown as Element);
    const render = async (props: FocusHarnessProps) => {
      await act(() => root.render(<FocusHarness {...props} />));
    };
    const activeTarget = () => document.activeElement?.getAttribute("data-test-focus");

    try {
      await render({
        editor: { kind: "rename", connectionId: "connection-1" },
        notice: null,
        completion: null,
        showRemove: true,
      });
      container.querySelector('[data-test-focus="editor"]')?.focus();
      await render({
        editor: { kind: "rename", connectionId: "connection-1" },
        notice: pending("rename:connection-1"),
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("status");
      await render({
        editor: null,
        notice: null,
        completion: completed(1, "rename:connection-1"),
        showRemove: true,
      });
      expect(activeTarget()).toBe("rename");

      await render({
        editor: { kind: "replace", connectionId: "connection-1" },
        notice: pending("replace:connection-1"),
        completion: null,
        showRemove: true,
      });
      await render({
        editor: null,
        notice: null,
        completion: completed(2, "replace:connection-1"),
        showRemove: true,
      });
      expect(activeTarget()).toBe("replace");

      await render({
        editor: null,
        notice: pending("remove:connection-1"),
        completion: null,
        showRemove: true,
      });
      await render({
        editor: null,
        notice: null,
        completion: completed(3, "remove:connection-1"),
        showRemove: false,
      });
      expect(activeTarget()).toBe("add");

      await render({
        editor: null,
        notice: pending("remove:connection-1"),
        completion: null,
        showRemove: true,
      });
      await render({
        editor: null,
        notice: null,
        completion: completed(4, "remove:connection-1", "Interrupted"),
        showRemove: true,
      });
      expect(activeTarget()).toBe("remove");

      outside.focus();
      await render({
        connected: false,
        editor: null,
        notice: null,
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("outside");
      await render({
        connected: true,
        editor: null,
        notice: null,
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("outside");

      container.querySelector('[data-test-focus="add"]')?.focus();
      document.clearFocus();
      await render({
        connected: false,
        editor: null,
        notice: null,
        completion: null,
        showRemove: true,
      });
      expect(document.activeElement).toBeNull();
      await render({
        connected: true,
        editor: null,
        notice: null,
        completion: null,
        showRemove: true,
      });
      expect(document.activeElement).toBeNull();
    } finally {
      await act(() => root.unmount());
    }
  });

  it("moves focus through disconnect, reconnect, completion, and error dismissal", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const render = async (props: FocusHarnessProps) => {
      await act(() => root.render(<FocusHarness {...props} />));
    };
    const activeTarget = () => document.activeElement?.getAttribute("data-test-focus");

    try {
      await render({
        connected: true,
        editor: { kind: "replace", connectionId: "connection-1" },
        notice: null,
        completion: null,
        showRemove: true,
      });
      container.querySelector('[data-test-focus="editor"]')?.focus();
      expect(activeTarget()).toBe("editor");

      await render({
        connected: false,
        editor: { kind: "replace", connectionId: "connection-1" },
        notice: null,
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("discard");
      await render({
        connected: true,
        editor: { kind: "replace", connectionId: "connection-1" },
        notice: null,
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("editor");

      await render({
        connected: false,
        editor: null,
        notice: pending("remove:connection-1"),
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("status");
      await render({
        connected: false,
        editor: null,
        notice: null,
        completion: completed(1, "remove:connection-1"),
        showRemove: false,
      });
      expect(activeTarget()).toBe("unavailable");

      await render({
        connected: true,
        editor: null,
        notice: pending("remove:connection-1"),
        completion: null,
        showRemove: true,
      });
      await render({
        connected: true,
        editor: null,
        notice: { _tag: "Error", key: "remove:connection-1", message: "Failed" },
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("status");
      await render({
        connected: true,
        editor: null,
        notice: null,
        completion: null,
        showRemove: true,
      });
      expect(activeTarget()).toBe("remove");
    } finally {
      await act(() => root.unmount());
    }
  });

  it("renders a manual validation message and focuses its input", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.appendChild(container);
    const root = createRoot(container as unknown as Element);

    try {
      await act(() =>
        root.render(
          <>
            <input id="connection-name" aria-describedby="connection-name-error" />
            <OnshapeFieldError
              id="connection-name-error"
              inputId="connection-name"
              focusRequest={1}
            >
              Enter a connection name.
            </OnshapeFieldError>
          </>,
        ),
      );

      expect(document.getElementById("connection-name-error")?.getAttribute("role")).toBe("alert");
      expect(document.activeElement?.getAttribute("id")).toBe("connection-name");
    } finally {
      await act(() => root.unmount());
    }
  });

  it("refocuses the first invalid field on every add-form submission", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.appendChild(container);
    const outside = document.createElement("button");
    document.appendChild(outside);
    const root = createRoot(container as unknown as Element);
    const onSave = vi.fn(async () => null);

    try {
      await act(() =>
        root.render(
          <AddConnectionForm
            formId="add-connection"
            pending={false}
            onCancel={() => undefined}
            onSave={onSave}
          />,
        ),
      );
      const form = container.querySelector("form");
      const inputs = container.querySelectorAll("input");
      expect(form).not.toBeNull();
      expect(inputs).toHaveLength(4);

      await act(() => {
        form?.dispatchEvent(new TestDomEvent("submit", { bubbles: true, cancelable: true }));
      });
      expect(inputs.map((input) => input.getAttribute("aria-invalid"))).toEqual([
        "true",
        null,
        "true",
        "true",
      ]);
      expect(document.activeElement).toBe(inputs[0]);
      expect(onSave).not.toHaveBeenCalled();

      outside.focus();
      await act(() => {
        form?.dispatchEvent(new TestDomEvent("submit", { bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(inputs[0]);
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
    }
  });
});
