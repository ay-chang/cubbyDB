import { useState } from "react";

import { useStore } from "../../state/store";
import type { Theme } from "../../state/store";

/** Settings sections. Only "Appearance" exists for now, but the rail is built
 *  to grow. */
type Section = "appearance";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "appearance", label: "Appearance" },
];

/**
 * The application settings modal, opened from the top bar. A left rail lists
 * sections; the panel on the right shows the active one. For now the only
 * section is Appearance, which toggles the light/dark theme.
 */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.closeSettings);
  const [section, setSection] = useState<Section>("appearance");

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-card"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="settings-rail">
          <div className="settings-rail__title caption">Settings</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={
                "settings-rail__item" +
                (section === s.id ? " settings-rail__item--active" : "")
              }
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          <div className="settings-panel__head">
            <span className="settings-panel__title">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              className="settings-panel__close"
              onClick={close}
              title="Close"
              aria-label="Close settings"
            >
              ×
            </button>
          </div>

          {section === "appearance" && <AppearanceSection />}
        </div>
      </div>
    </div>
  );
}

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "light", label: "Light", hint: "Bright surfaces" },
  { id: "dark", label: "Dark", hint: "Dim, low-glare" },
];

function AppearanceSection() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  return (
    <div className="settings-section">
      <div className="settings-field">
        <div className="settings-field__label">Theme</div>
        <div className="settings-field__desc">
          Choose how CubbyDB looks. Your choice is saved for next time.
        </div>
        <div className="theme-choices">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={
                "theme-choice" +
                (theme === t.id ? " theme-choice--active" : "")
              }
              onClick={() => setTheme(t.id)}
              aria-pressed={theme === t.id}
            >
              <span className={`theme-choice__swatch theme-choice__swatch--${t.id}`}>
                <span className="theme-choice__swatch-bar" />
                <span className="theme-choice__swatch-dot" />
              </span>
              <span className="theme-choice__meta">
                <span className="theme-choice__label">{t.label}</span>
                <span className="theme-choice__hint">{t.hint}</span>
              </span>
              {theme === t.id && <span className="theme-choice__check">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
