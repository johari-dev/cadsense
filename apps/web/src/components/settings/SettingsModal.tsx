import { Link, useCanGoBack, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { EnvironmentId } from "@cadsense/contracts";

import { MagnifyingGlassIcon as SearchIcon, XIcon } from "~/lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";
import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import {
  AppearanceSettingsPanel,
  ArchivedThreadsPanel,
  GeneralSettingsPanel,
} from "./SettingsPanels";
import { scrollToSettingsTarget, SettingsTabLabelProvider } from "./settingsLayout";
import { settingsLocation, SETTINGS_TAB_LABELS, type SettingsTab } from "./settingsLocation";
import { searchSettings, type SettingsSearchItem } from "./settingsSearch";

const SETTINGS_TABS = Object.entries(SETTINGS_TAB_LABELS) as ReadonlyArray<
  readonly [keyof typeof SETTINGS_TAB_LABELS, string]
>;

/**
 * Mounted once in the root layout. Renders the settings modal over the current page while the
 * `settings` search param is set, and nothing otherwise. The page behind stays mounted.
 */
export function SettingsOverlay() {
  const search = useSearch({ from: "__root__" });
  if (search.settings === undefined) return null;
  return (
    <SettingsModal tab={search.settings}>
      <SettingsPage tab={search.settings} onshapeEnvironmentId={search.onshapeEnvironmentId} />
    </SettingsModal>
  );
}

function SettingsPage({
  tab,
  onshapeEnvironmentId,
}: {
  tab: SettingsTab;
  onshapeEnvironmentId: EnvironmentId | undefined;
}) {
  switch (tab) {
    case "general":
      return <GeneralSettingsPanel />;
    case "appearance":
      return <AppearanceSettingsPanel />;
    case "keybindings":
      return <KeybindingsSettingsPanel />;
    case "providers":
      return <ProviderSettingsPanel />;
    case "integrations":
      return <IntegrationsSettingsPanel onshapeEnvironmentId={onshapeEnvironmentId} />;
    case "archived":
      return <ArchivedThreadsPanel />;
    case "diagnostics":
      return <DiagnosticsSettingsPanel />;
  }
}

/**
 * Closes settings. Opening settings pushes one history entry and moving around inside it
 * replaces, so Back returns to the page as it was. A settings link opened fresh has nothing
 * to go back to, so it drops the settings params in place.
 */
function useCloseSettings() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: ".", search: {}, hash: "", replace: true });
  }, [canGoBack, navigate]);
}

/**
 * The settings shell: a centered modal with a tab per settings page and a search box. It
 * portals to the body above the live page, takes focus so typing does not reach the page
 * behind, and hands focus back when it closes. The close button, a backdrop click, and
 * Escape all close it.
 */
function SettingsModal({ tab, children }: { tab: SettingsTab; children: ReactNode }) {
  const onClose = useCloseSettings();
  const dialogRef = useRef<HTMLDivElement>(null);
  const tabLabel = tab === "diagnostics" ? null : SETTINGS_TAB_LABELS[tab];

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/60" aria-hidden onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        // Marks an open floating layer, so the chat behind does not turn typing into composer text.
        data-slot="dialog"
        tabIndex={-1}
        className="fixed top-1/2 left-1/2 z-50 flex h-[min(720px,calc(100dvh-2rem))] w-[min(960px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-popover-border bg-card text-foreground shadow-xl outline-none"
      >
        <div className="flex items-center gap-3 pt-4 pr-4 pb-3 pl-7">
          <h1 className="text-base font-semibold">Settings</h1>
          <div className="flex-1" />
          <SettingsSearch tab={tab} />
          <Button size="icon" variant="ghost" aria-label="Close settings" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
        <nav
          aria-label="Settings pages"
          className="flex gap-1 overflow-x-auto border-b border-border px-[1.125rem]"
        >
          {SETTINGS_TABS.map(([tabId, label]) => {
            const isActive = tab === tabId;
            return (
              <Link
                key={tabId}
                {...settingsLocation(tabId)}
                replace
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative shrink-0 px-2.5 py-2.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
                  isActive &&
                    "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground",
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <SettingsTabLabelProvider label={tabLabel}>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </SettingsTabLabelProvider>
      </div>
    </>,
    document.body,
  );
}

/**
 * Settings search. `/` focuses it from anywhere outside a field or popup, the arrow keys
 * move through results, Enter opens one, and Escape clears the query before it closes
 * settings.
 */
function SettingsSearch({ tab }: { tab: SettingsTab }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const results = useMemo(() => searchSettings(query), [query]);
  const isSearching = query.trim().length > 0;
  const activeResult = isSearching ? results[activeResultIndex] : undefined;

  useEffect(() => {
    if (!activeResult) return;
    document
      .getElementById(`settings-search-result-${activeResult.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResult]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          // Popups inside settings keep their own focus trap.
          target.closest('[data-slot$="popup"]') !== null)
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const openResult = useCallback(
    (item: SettingsSearchItem) => {
      clearSearch();
      const targetId = item.targetId ?? item.id;
      if (tab === item.tab && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({
        ...settingsLocation(item.tab),
        hash: targetId,
        replace: true,
        hashScrollIntoView: false,
      });
    },
    [clearSearch, currentHash, navigate, tab],
  );
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (!isSearching || results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      openResult(activeResult);
    }
  };

  return (
    <div className="relative w-64">
      <div className="flex h-8 items-center gap-2 rounded-[var(--control-radius)] border border-input bg-muted px-2.5">
        <SearchIcon className="size-3.5 shrink-0 text-icon-muted" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveResultIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search settings"
          aria-label="Search settings"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isSearching && results.length > 0}
          aria-controls={isSearching && results.length > 0 ? "settings-search-results" : undefined}
          aria-activedescendant={
            activeResult ? `settings-search-result-${activeResult.id}` : undefined
          }
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder [&::-webkit-search-cancel-button]:hidden"
        />
        {isSearching ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Clear settings search"
            onClick={() => {
              clearSearch();
              inputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : (
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">/</Kbd>
        )}
      </div>
      {isSearching ? (
        <div className="absolute top-9 right-0 left-0 z-10 max-h-80 overflow-y-auto rounded-lg border border-popover-border bg-popover p-1 shadow-lg">
          {results.length === 0 ? (
            <p role="status" className="px-2.5 py-4 text-center text-xs text-muted-foreground">
              No settings found
            </p>
          ) : (
            <div id="settings-search-results" role="listbox" aria-label="Settings search results">
              {results.map((item, index) => (
                <button
                  key={item.id}
                  id={`settings-search-result-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeResultIndex}
                  tabIndex={-1}
                  className={cn(
                    "block w-full rounded-md px-2.5 py-1.5 text-left",
                    index === activeResultIndex && "bg-accent",
                  )}
                  onMouseMove={() => setActiveResultIndex(index)}
                  onClick={() => openResult(item)}
                >
                  <span className="block truncate text-sm text-foreground">{item.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {item.tab === "diagnostics" ? "Diagnostics" : SETTINGS_TAB_LABELS[item.tab]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
