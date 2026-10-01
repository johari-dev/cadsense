import { modelThumbnailKey, useModelThumbnails } from "../cad/modelThumbnails";
import type { EnvironmentId, OnshapeProjectSource } from "@cadsense/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@cadsense/shared/projectFavicon";
import { FolderIcon } from "@phosphor-icons/react";
import type { ComponentType } from "react";
import { useState } from "react";
import { useAssetUrlState } from "../assets/assetUrls";
import { cn } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Map<string, string>();

type ProjectFaviconProps = {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
  onshapeSource?: OnshapeProjectSource | undefined;
  cadSnapshotId?: string | undefined;
};

export function ProjectFavicon(input: ProjectFaviconProps) {
  if (input.cadSnapshotId) return <ProjectModelThumbnail {...input} />;
  if (input.onshapeSource) {
    return (
      <img
        src="/onshape.svg"
        alt=""
        className={cn("size-3.5 shrink-0 object-contain", input.className)}
      />
    );
  }
  return <LocalProjectFavicon {...input} />;
}

function ProjectModelThumbnail(input: ProjectFaviconProps) {
  const thumbnail = useModelThumbnails((state) =>
    input.cadSnapshotId
      ? state.images[modelThumbnailKey(input.environmentId, input.cadSnapshotId)]
      : undefined,
  );
  if (thumbnail)
    return (
      <img
        src={thumbnail}
        alt=""
        className={cn("size-7 shrink-0 rounded object-cover", input.className)}
      />
    );
  return <ProjectFavicon {...input} cadSnapshotId={undefined} />;
}

function LocalProjectFavicon(input: ProjectFaviconProps) {
  const state = useProjectFaviconAsset(input);
  const src = state._tag === "Success" ? state.url : null;
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />;
  }

  const cacheKey = getProjectFaviconCacheKey(input.environmentId, input.cwd, src);

  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
    />
  );
}

export function useProjectFaviconAsset(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  return useAssetUrlState(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
  });
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  cacheKey,
  src,
  className,
  fallbackIcon: FallbackIcon,
}: {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedProjectFaviconSrcs.get(cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedProjectFaviconSrcs.get(cacheKey) === failedSrc) {
      loadedProjectFaviconSrcs.delete(cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} />
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            loadedProjectFaviconSrcs.set(cacheKey, src);
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
