import { RuntimeMode } from "@cadsense/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useClientSettings } from "../../hooks/useSettings";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const showPermissions = useClientSettings((settings) => settings.showPermissionSettings);
  if (!showPermissions && !props.traitsMenuContent) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            {showPermissions && <MenuDivider />}
          </>
        ) : null}
        {showPermissions && (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
              <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
              <MenuRadioItem value="auto">Auto</MenuRadioItem>
              <MenuRadioItem value="full-access">Full access</MenuRadioItem>
            </MenuRadioGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
