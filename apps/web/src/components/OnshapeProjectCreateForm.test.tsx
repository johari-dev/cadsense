import { EnvironmentId, OnshapeConnectionId } from "@cadsense/contracts";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const state = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useId: () => "test",
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("./settings/useOnshapeConnectionsController", () => ({
  useOnshapeConnectionsController: state.catalog,
}));
import { OnshapeProjectCreateForm } from "./OnshapeProjectCreateForm";

interface ControlProps {
  id?: string;
  children?: ReactNode;
  role?: string;
  type?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
}
function control(
  tree: ReactNode,
  predicate: (props: ControlProps) => boolean,
): ControlProps | undefined {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const result = control(child, predicate);
      if (result) return result;
    }
  }
  if (!isValidElement<ControlProps>(tree)) return undefined;
  return predicate(tree.props) ? tree.props : control(tree.props.children, predicate);
}
const connectionId = OnshapeConnectionId.make("11111111-1111-4111-8111-111111111111");
const connections = [{ connectionId, name: "Personal", host: "cad.onshape.com" }];
const catalog = {
  connections,
  hasListData: true,
  listError: null,
  isListPending: false,
  interactionsDisabled: false,
  refresh: vi.fn(),
};

describe("Onshape project creation form", () => {
  beforeEach(() => {
    hooks.reset();
    state.catalog.mockReturnValue(catalog);
  });
  function setup() {
    const create = vi
      .fn<
        (input: {
          title: string;
          url: string;
          connectionId: OnshapeConnectionId;
        }) => Promise<string | null>
      >()
      .mockResolvedValue(null);
    const render = () => {
      hooks.beginRender();
      return OnshapeProjectCreateForm({
        environmentId: EnvironmentId.make("test"),
        environmentLabel: "This computer",
        connected: true,
        onCancel: vi.fn(),
        onConfigure: vi.fn(),
        onCreate: create,
      });
    };
    const change = (id: string, value: string) =>
      control(render(), (props) => props.id === `test-${id}`)?.onChange?.({ target: { value } });
    const submit = () =>
      control(render(), (props) => props.onSubmit !== undefined)?.onSubmit?.({
        preventDefault: vi.fn(),
      });
    return { create, render, change, submit };
  }
  it("rejects blank fields and submits trimmed input using the chosen connection", async () => {
    const form = setup();
    await form.submit();
    expect(form.create).not.toHaveBeenCalled();
    expect(control(form.render(), (props) => props.role === "alert")?.children).toBe(
      "Enter a project name.",
    );
    form.change("name", "  My CAD  ");
    await form.submit();
    expect(control(form.render(), (props) => props.role === "alert")?.children).toBe(
      "Enter an Onshape document or element URL.",
    );
    form.change("url", "  https://cad.onshape.com/documents/example  ");
    form.change("connection", connectionId);
    await form.submit();
    expect(form.create).toHaveBeenCalledExactlyOnceWith({
      title: "My CAD",
      url: "https://cad.onshape.com/documents/example",
      connectionId,
    });
  });
  it("does not switch to another connection when the selected one is removed", async () => {
    const form = setup();
    form.change("name", "CAD");
    form.change("url", "https://cad.onshape.com/documents/example");
    form.change("connection", connectionId);
    state.catalog.mockReturnValue({
      ...catalog,
      connections: [
        {
          ...connections[0],
          connectionId: OnshapeConnectionId.make("22222222-2222-4222-8222-222222222222"),
        },
      ],
    });
    await form.submit();
    expect(form.create).not.toHaveBeenCalled();
  });
  it("prevents concurrent submits while a create is unresolved and while connections are mutating", async () => {
    const form = setup();
    form.change("name", "CAD");
    form.change("url", "https://cad.onshape.com/documents/example");
    form.change("connection", connectionId);
    state.catalog.mockReturnValue({ ...catalog, interactionsDisabled: true });
    await form.submit();
    expect(form.create).not.toHaveBeenCalled();
    state.catalog.mockReturnValue(catalog);
    let complete: (value: string | null) => void = () => {};
    form.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = form.submit();
    await form.submit();
    expect(form.create).toHaveBeenCalledTimes(1);
    complete(null);
    await pending;
  });
});
