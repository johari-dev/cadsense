import type { ComponentType, Dispatch, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeWorkspaceId,
  type EnvironmentId,
} from "@cadsense/contracts";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastResource: null as unknown,
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.lastResource = resource;
    return { _tag: "Success", url: testState.faviconUrl };
  },
}));

import { ProjectFavicon } from "./ProjectFavicon";

type ProjectFaviconImageProps = {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
};

type ImageElement = ReactElement<{
  readonly src: string;
  readonly onLoad?: () => void;
  readonly onError?: () => void;
}>;

type ProjectFaviconImageElement = ReactElement<{
  readonly children: [ReactElement | null, ImageElement | null, ImageElement | null];
}>;

function resolveImageComponent(): {
  readonly Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement;
  readonly props: ProjectFaviconImageProps;
} {
  hooks.beginRender();
  const wrapper = ProjectFavicon({
    environmentId: "environment-test" as EnvironmentId,
    cwd: "/workspace-test",
  }) as ReactElement<Parameters<typeof ProjectFavicon>[0]>;
  const LocalFavicon = wrapper.type as (
    props: Parameters<typeof ProjectFavicon>[0],
  ) => ReactElement<ProjectFaviconImageProps>;
  hooks.reset();
  const element = LocalFavicon(wrapper.props);
  hooks.reset();

  return {
    Component: element.type as (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
    props: element.props,
  };
}

function renderImage(
  Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
  props: ProjectFaviconImageProps,
): ProjectFaviconImageElement {
  hooks.beginRender();
  return Component(props);
}

describe("ProjectFavicon", () => {
  beforeEach(() => {
    hooks.reset();
    testState.lastResource = null;
  });

  it("does not request a filesystem favicon for an Onshape project", () => {
    ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/managed/onshape/project",
      onshapeSource: {
        connectionId: OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001"),
        host: "https://cad.onshape.com",
        documentId: OnshapeDocumentId.make("05760c4d8b40fba37db8fa48"),
        workspaceType: "w",
        workspaceId: OnshapeWorkspaceId.make("f31b499c519e8471cced93dc"),
        configuration: "",
      },
    });
    expect(testState.lastResource).toBeNull();
    resolveImageComponent();
    expect(testState.lastResource).toEqual({ _tag: "project-favicon", cwd: "/workspace-test" });
  });

  it("falls back when the displayed favicon fails without discarding a valid older image early", () => {
    const { Component, props } = resolveImageComponent();
    const initialLoadingImage = renderImage(Component, props).props.children[2];
    initialLoadingImage?.props.onLoad?.();

    const refreshedProps = {
      ...props,
      src: "https://environment.test/api/assets/token-b/v1-20-favicon.svg",
    };
    const refreshing = renderImage(Component, refreshedProps).props.children;
    expect(refreshing[1]?.props.src).toBe(props.src);
    refreshing[2]?.props.onError?.();

    const afterRefreshError = renderImage(Component, refreshedProps).props.children;
    expect(afterRefreshError[1]?.props.src).toBe(props.src);
    afterRefreshError[1]?.props.onError?.();

    const afterDisplayedError = renderImage(Component, refreshedProps).props.children;
    expect(afterDisplayedError[0]).not.toBeNull();
    expect(afterDisplayedError[1]).toBeNull();
  });
});
