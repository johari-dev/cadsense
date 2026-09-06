import type { EnvironmentId, ScopedThreadRef } from "@cadsense/contracts";
import { isWorkspaceImagePreviewPath } from "@cadsense/shared/filePreview";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import { ChevronRight, Code2, Eye, FolderTree, Globe2, LoaderCircle } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { useAssetUrlState } from "~/assets/assetUrls";
import { OpenInExplorerButton } from "~/components/chat/OpenInExplorerButton";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { resolvePathLinkTarget } from "~/path-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import FileBrowserPanel from "./FileBrowserPanel";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { fileBreadcrumbs } from "./filePath";
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  selectedFilePending: boolean;
  workspaceMutationId: string | null;
}

const FILE_EXPLORER_STORAGE_KEY = "cadsense.fileExplorerOpen";
const RENDER_MARKDOWN_STORAGE_KEY = "cadsense.renderMarkdown";
const FILE_SAVE_DEBOUNCE_MS = 500;

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly alt: string;
  readonly workspaceMutationId: string | null;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
  const imageUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;

  if (assetUrl._tag === "Failure" || (imageUrl !== null && failedUrl === imageUrl)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
        Unable to load workspace image.
      </div>
    );
  }
  return assetUrl._tag === "Success" && imageUrl !== null ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        className="max-h-full max-w-full object-contain"
        src={imageUrl}
        alt={props.alt}
        onError={() => setFailedUrl(imageUrl)}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

function useFileSaveCoordinator(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const coordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => input.onPendingChange(input.relativePath, pending),
        persist: (contents) =>
          writeFile({
            environmentId: input.environmentId,
            input: { cwd: input.cwd, relativePath: input.relativePath, contents },
          }),
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(input.environmentId, input.cwd, input.relativePath, contents),
      }),
    [input.cwd, input.environmentId, input.onPendingChange, input.relativePath, writeFile],
  );
  useEffect(() => () => coordinator.dispose(), [coordinator]);
  return coordinator;
}

function lineOffset(contents: string, line: number): number {
  if (line <= 1) return 0;
  let cursor = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const next = contents.indexOf("\n", cursor);
    if (next < 0) return contents.length;
    cursor = next + 1;
  }
  return cursor;
}

function EditableFileSurface(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  contents: string;
  revealLine: number | null;
  revealRequestId: number;
  wordWrap: boolean;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}) {
  const [contents, setContents] = useState(props.contents);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const save = useFileSaveCoordinator(props);
  useEffect(() => setContents(props.contents), [props.contents, props.relativePath]);
  useEffect(() => {
    if (props.revealLine === null) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const offset = lineOffset(contents, props.revealLine);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(offset, offset);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(
      0,
      (props.revealLine - 1) * lineHeight - textarea.clientHeight / 2,
    );
  }, [contents, props.revealLine, props.revealRequestId]);

  return (
    <textarea
      ref={textareaRef}
      aria-label={`Edit ${props.relativePath}`}
      className={cn(
        "min-h-0 flex-1 resize-none border-0 bg-code-background p-4 font-mono text-code-foreground outline-none",
        props.wordWrap ? "whitespace-pre-wrap" : "whitespace-pre overflow-x-auto",
      )}
      spellCheck={false}
      value={contents}
      wrap={props.wordWrap ? "soft" : "off"}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setContents(next);
        setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, next);
        save.change(next);
      }}
    />
  );
}

function ReadOnlyFileSurface(props: {
  contents: string;
  revealLine: number | null;
  revealRequestId: number;
  wordWrap: boolean;
}) {
  const containerRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (props.revealLine === null || !containerRef.current) return;
    const lineHeight = Number.parseFloat(getComputedStyle(containerRef.current).lineHeight) || 20;
    containerRef.current.scrollTop = Math.max(
      0,
      (props.revealLine - 1) * lineHeight - containerRef.current.clientHeight / 2,
    );
  }, [props.revealLine, props.revealRequestId]);
  return (
    <pre
      ref={containerRef}
      className={cn(
        "m-0 min-h-0 flex-1 overflow-auto bg-code-background p-4 font-mono text-code-foreground",
        props.wordWrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
      )}
    >
      {props.contents}
    </pre>
  );
}

function RenderedMarkdownSurface(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  contents: string;
  threadRef: ScopedThreadRef;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}) {
  const save = useFileSaveCoordinator(props);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        text={props.contents}
        cwd={props.cwd}
        relativePath={props.relativePath}
        threadRef={props.threadRef}
        onTaskListChange={({ markerOffset, checked }) => {
          const current =
            getOptimisticProjectFileQueryData(props.environmentId, props.cwd, props.relativePath)
              ?.contents ?? props.contents;
          const next = setMarkdownTaskChecked(current, markerOffset, checked);
          if (next === current) return;
          setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, next);
          save.change(next);
        }}
      />
    </ScrollArea>
  );
}

function initialExplorerOpen(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? true;
  } catch {
    return true;
  }
}

export default function FilePreviewPanel(props: FilePreviewPanelProps) {
  const wordWrap = true;
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(props.environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const isImage = props.relativePath !== null && isWorkspaceImagePreviewPath(props.relativePath);
  const file = useProjectFileQuery(props.environmentId, props.cwd, props.relativePath, !isImage);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = props.relativePath ? isMarkdownPreviewFile(props.relativePath) : false;
  const renderMarkdown =
    isMarkdown &&
    renderMarkdownPreferred &&
    (props.revealLine === null ||
      (handledReveal?.path === props.relativePath &&
        handledReveal.requestId === props.revealRequestId));
  const canOpenInBrowser =
    props.relativePath !== null &&
    isPreviewSupportedInRuntime() &&
    isBrowserPreviewFile(props.relativePath);
  const absolutePath = props.relativePath
    ? resolvePathLinkTarget(props.relativePath, props.cwd)
    : null;
  const breadcrumbs = useMemo(
    () => (props.relativePath ? fileBreadcrumbs(props.projectName, props.relativePath) : []),
    [props.projectName, props.relativePath],
  );

  useWorkspaceMutationRefresh({
    enabled: props.relativePath !== null && !isImage && !props.selectedFilePending,
    mutationId: props.workspaceMutationId,
    refresh: file.refresh,
    resourceKey: `file:${props.environmentId}:${props.cwd}:${props.relativePath ?? ""}`,
  });
  useEffect(() => {
    breadcrumbRef.current
      ?.querySelector<HTMLElement>("[data-current-file-crumb='true']")
      ?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [props.relativePath]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch {
        // The panel remains usable when storage is unavailable.
      }
      return next;
    });
  };
  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl) return;
    void openFileInPreview({
      threadRef: props.threadRef,
      filePath: absolutePath,
      httpBaseUrl: environmentHttpBaseUrl,
      createAssetUrl,
      openPreview,
    }).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [absolutePath, createAssetUrl, environmentHttpBaseUrl, openPreview, props.threadRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {props.relativePath ? (
        <div
          className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3"
          data-surface-subheader
        >
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 text-muted-foreground/60" />
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "max-w-40 truncate",
                            crumb.kind === "file" ? "font-medium" : "text-muted-foreground",
                          )}
                        />
                      }
                    >
                      {crumb.label}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{crumb.path || props.projectName}</TooltipPopup>
                  </Tooltip>
                </div>
              ))}
            </div>
          </ScrollArea>
          {absolutePath ? (
            <OpenInExplorerButton environmentId={props.environmentId} path={absolutePath} reveal />
          ) : null}
          {isMarkdown ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    pressed={renderMarkdown}
                    onPressedChange={(pressed) => {
                      setRenderMarkdownPreferred(pressed);
                      setHandledReveal(
                        pressed && props.relativePath
                          ? { path: props.relativePath, requestId: props.revealRequestId }
                          : null,
                      );
                    }}
                    aria-label={renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
                    variant="ghost"
                    size="sm"
                  />
                }
              >
                {renderMarkdown ? <Code2 className="size-3.5" /> : <Eye className="size-3.5" />}
              </TooltipTrigger>
              <TooltipPopup>
                {renderMarkdown ? "Show markdown source" : "Show rendered markdown"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {canOpenInBrowser ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    pressed={false}
                    onPressedChange={handleOpenInBrowser}
                    aria-label="Open file in preview browser"
                    variant="ghost"
                    size="sm"
                  />
                }
              >
                <Globe2 className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Open file in preview browser</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="ghost"
                  size="sm"
                />
              }
            >
              <FolderTree className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {props.relativePath && file.data?.truncated ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            props.relativePath ? "flex" : "hidden",
          )}
        >
          {props.relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              environmentId={props.environmentId}
              threadRef={props.threadRef}
              absolutePath={absolutePath}
              alt={props.relativePath}
              workspaceMutationId={props.workspaceMutationId}
            />
          ) : props.relativePath && file.error && file.data === null ? (
            <div className="flex flex-1 items-center justify-center text-xs text-destructive">
              {file.error}
            </div>
          ) : props.relativePath && file.data === null ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : props.relativePath && file.data ? (
            isMarkdown && renderMarkdown ? (
              <RenderedMarkdownSurface
                environmentId={props.environmentId}
                cwd={props.cwd}
                relativePath={props.relativePath}
                threadRef={props.threadRef}
                contents={file.data.contents}
                onPendingChange={props.onPendingChange}
              />
            ) : file.data.truncated ? (
              <ReadOnlyFileSurface
                contents={file.data.contents}
                revealLine={props.revealLine}
                revealRequestId={props.revealRequestId}
                wordWrap={wordWrap}
              />
            ) : (
              <EditableFileSurface
                key={props.relativePath}
                environmentId={props.environmentId}
                cwd={props.cwd}
                relativePath={props.relativePath}
                contents={file.data.contents}
                revealLine={props.revealLine}
                revealRequestId={props.revealRequestId}
                wordWrap={wordWrap}
                onPendingChange={props.onPendingChange}
              />
            )
          ) : null}
        </div>
        {explorerOpen || props.relativePath === null ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              props.relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${props.environmentId}:${props.cwd}`}
              environmentId={props.environmentId}
              cwd={props.cwd}
              projectName={props.projectName}
              selectedPath={props.relativePath}
              selectedPathRevealId={props.revealRequestId}
              onOpenFile={props.onOpenFile}
              workspaceMutationId={props.workspaceMutationId}
              {...(props.relativePath && !isImage ? { onRefreshSelectedFile: file.refresh } : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
