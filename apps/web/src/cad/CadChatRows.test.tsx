import { scopedThreadKey } from "@cadsense/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@cadsense/contracts";
import { isValidElement, type ReactNode } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { useRightPanelStore } from "../rightPanelStore";
import { useCadCommentReviewStore } from "./cadCommentReviewStore";
import {
  CadPublishedComments,
  describeCadCommentRejection,
  describeCadCommentsPublished,
} from "./CadChatRows";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
};

afterEach(() => {
  useCadCommentReviewStore.setState({ pending: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
});

function elements(node: ReactNode): Array<React.ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  if (typeof node.type === "function") return "";
  return text(node.props.children as ReactNode);
}

const card = {
  published: [
    {
      publicationKey: "motor",
      commentId: "comment-1",
      number: 1,
      title: "Can this motor come out without removing the roller shaft?",
      location: "Motor mount",
    },
  ],
  rejected: [{ publicationKey: "gusset", title: "Add bolt heads", reason: "candidate-expired" }],
  proposed: [],
};

it("opens a published comment at its location in the CAD panel", () => {
  const tree = CadPublishedComments({ card, threadRef });
  const buttons = elements(tree).filter((element) => element.type === "button");
  expect(text(tree)).toContain("Wrote 1 comment");
  expect(text(tree)).toContain('"Add bolt heads" was not published');

  const commentButton = buttons.find((button) => text(button).includes("roller shaft"));
  (commentButton?.props.onClick as () => void)();
  expect(useCadCommentReviewStore.getState().pending[scopedThreadKey(threadRef)]).toEqual({
    id: "comment-1",
    target: 0,
  });
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
    isOpen: true,
    activeSurfaceId: "cad",
  });
});

it("describes unknown rejection reasons without leaking codes", () => {
  expect(describeCadCommentRejection({ title: null, reason: "render-busy" })).toBe(
    "A finding was not published: the CAD view could not be rendered.",
  );
  expect(describeCadCommentRejection({ title: "Wire slack", reason: "something-new" })).toBe(
    '"Wire slack" was not published: the server rejected it.',
  );
});

it("lists resolution proposals apart from written comments and opens their comment", () => {
  const proposals = {
    published: [],
    rejected: [],
    proposed: [
      { publicationKey: "fixed", commentId: "comment-2", number: 2, title: "Loose cable" },
    ],
  };
  expect(describeCadCommentsPublished(proposals)).toBe("Proposed 1 resolution");
  expect(describeCadCommentsPublished({ ...card, proposed: proposals.proposed })).toBe(
    "Wrote 1 comment, proposed 1 resolution",
  );
  const tree = CadPublishedComments({ card: proposals, threadRef });
  expect(text(tree)).toContain("resolution proposed");
  const button = elements(tree)
    .filter((element) => element.type === "button")
    .find((element) => text(element).includes("Loose cable"));
  (button!.props.onClick as () => void)();
  expect(useCadCommentReviewStore.getState().pending[scopedThreadKey(threadRef)]).toEqual({
    id: "comment-2",
    target: 0,
  });
});
