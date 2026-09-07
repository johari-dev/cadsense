import { useEffect, useId, useState } from "react";
import {
  DEFAULT_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
  MAX_GLASS_OPACITY,
} from "@cadsense/contracts/settings";
import {
  getClientSettings,
  useClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function GlassOpacitySetting() {
  const id = useId();
  const opacity = useClientSettings((settings) => settings.glassOpacity);
  const updateSettings = useUpdatePrimarySettings();
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? opacity;

  useEffect(
    () => () => {
      document.documentElement.style.setProperty(
        "--glass-opacity",
        `${getClientSettings().glassOpacity}%`,
      );
    },
    [],
  );

  function commit(next: number) {
    if (next !== getClientSettings().glassOpacity) updateSettings({ glassOpacity: next });
    document.documentElement.style.setProperty("--glass-opacity", `${next}%`);
    setDraft(null);
  }

  return (
    <SettingsRow
      {...searchableSetting("glass-opacity")}
      description="Adjust glass surfaces from 40% opacity to fully solid at 100%."
      resetAction={
        opacity !== DEFAULT_GLASS_OPACITY ? (
          <SettingResetButton label="transparency" onClick={() => commit(DEFAULT_GLASS_OPACITY)} />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            htmlFor={id}
            className="min-w-12 rounded-md bg-muted px-2 py-1 text-center text-xs font-medium tabular-nums"
          >
            {value}%
          </output>
          <input
            id={id}
            aria-label="Transparency"
            aria-valuetext={`${value}% opacity`}
            type="range"
            min={MIN_GLASS_OPACITY}
            max={MAX_GLASS_OPACITY}
            step={1}
            value={value}
            className="h-6 min-w-0 flex-1 cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber;
              setDraft(next);
              document.documentElement.style.setProperty("--glass-opacity", `${next}%`);
            }}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerUp={(event) => commit(event.currentTarget.valueAsNumber)}
            onKeyUp={(event) => commit(event.currentTarget.valueAsNumber)}
            onBlur={(event) => commit(event.currentTarget.valueAsNumber)}
            onPointerCancel={() => {
              setDraft(null);
              document.documentElement.style.setProperty("--glass-opacity", `${opacity}%`);
            }}
          />
        </div>
      }
    />
  );
}
