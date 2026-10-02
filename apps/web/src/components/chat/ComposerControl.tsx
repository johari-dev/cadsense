import type { ComponentProps } from "react";
import {
  CaretDownIcon as ChevronDownIcon,
  type Icon as LucideIcon,
  type IconWeight,
} from "@phosphor-icons/react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SelectTrigger } from "../ui/select";

const composerControlClassName =
  "h-7 min-h-7 gap-1 rounded-full px-1.5 text-[11px] text-secondary-label font-normal transition-colors duration-150 motion-reduce:transition-none hover:text-foreground sm:h-7 sm:min-h-7 sm:text-[11px] [&_svg[data-composer-control-icon]]:mx-0 [&_svg[data-composer-control-chevron]]:-mx-0.5";

export function ComposerControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(composerControlClassName, className)}
      size={size}
      variant={variant}
      {...props}
    />
  );
}

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
  weight = "regular",
}: {
  icon: LucideIcon;
  className?: string | undefined;
  opticalSize?: "default" | "large";
  weight?: IconWeight;
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cn("shrink-0", opticalSize === "large" ? "size-4.5" : "size-4", className)}
      data-composer-control-icon
      weight={weight}
    />
  );
}

export function ComposerControlChevron() {
  return (
    <ChevronDownIcon
      aria-hidden="true"
      className="-mx-0.5 size-3.5 shrink-0 text-icon-muted"
      data-composer-control-chevron
      weight="bold"
    />
  );
}

export function ComposerSelectControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(composerControlClassName, className)}
      icon={<ComposerControlChevron />}
      size={size}
      variant={variant}
      {...props}
    />
  );
}
