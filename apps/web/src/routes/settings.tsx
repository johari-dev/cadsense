import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { SettingsModal } from "../components/settings/SettingsModal";
import { SidebarInset } from "../components/ui/sidebar";

function SettingsContentLayout() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();

        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          activeElement.blur();
        }

        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background">
      <SettingsModal onClose={navigateBackWithinApp}>
        <Outlet />
      </SettingsModal>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
