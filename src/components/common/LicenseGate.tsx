import { useState } from "react";

import { errorMessage } from "../../api/backend";
import { useStore } from "../../state/store";
import { BrandMark } from "./BrandMark";

/** Key entry + Activate, shared by Settings → License and the trial-ended
 *  lock screen. `withBuy` adds Settings' inline Buy button; the lock screen
 *  has its own, larger one. */
export function LicenseKeyForm({ withBuy = false }: { withBuy?: boolean }) {
  const activateLicense = useStore((s) => s.activateLicense);
  const openPurchasePage = useStore((s) => s.openPurchasePage);
  const [keyInput, setKeyInput] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = () => {
    const key = keyInput.trim();
    if (!key) return;
    setActivating(true);
    setError(null);
    void activateLicense(key).then(
      () => {
        setKeyInput("");
        setActivating(false);
      },
      (err) => {
        setError(errorMessage(err));
        setActivating(false);
      },
    );
  };

  return (
    <>
      <div className="settings-select-row">
        <input
          className="settings-input mono"
          placeholder="CUBBY-XXXXXXXX-…"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleActivate();
          }}
          spellCheck={false}
          aria-label="License key"
        />
        <button
          className="btn btn--primary"
          onClick={handleActivate}
          disabled={!keyInput.trim() || activating}
        >
          {activating ? "Checking…" : "Activate"}
        </button>
        {withBuy && (
          <button className="btn btn--outline" onClick={openPurchasePage}>
            Buy CubbyDB
          </button>
        )}
      </div>
      {error && <div className="settings-field__desc settings-field__desc--error">{error}</div>}
    </>
  );
}

const INCLUDED = ["One-time purchase", "Every future update", "Up to 3 computers", "Ask AI included"];

/** Replaces the whole app once an unlicensed install's trial has ended. */
export function LicenseGate() {
  const openPurchasePage = useStore((s) => s.openPurchasePage);

  return (
    <div className="license-gate" data-tauri-drag-region>
      <div className="license-gate__card">
        <BrandMark className="license-gate__mark" />
        <h1 className="license-gate__title">Your free trial has ended</h1>
        <p className="license-gate__lede">
          Buy CubbyDB to keep going. Your connections, saved queries, and history are right where
          you left them.
        </p>

        <button className="btn license-gate__buy" onClick={openPurchasePage}>
          Buy CubbyDB
          <span className="license-gate__buy-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <ul className="license-gate__included">
          {INCLUDED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <div className="license-gate__divider">
          <span>Already have a license?</span>
        </div>
        <LicenseKeyForm />
      </div>
    </div>
  );
}
