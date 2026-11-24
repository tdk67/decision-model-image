import { useState } from "preact/hooks";
import type { ProviderId, SavedCredential } from "../types";

interface ApiKeyPanelProps {
  activeProvider: ProviderId;
  savedKeys: Partial<Record<ProviderId, SavedCredential>>;
  onValidated: (cred: SavedCredential) => Promise<void>;
  onClear: (provider: ProviderId) => Promise<void>;
  onClose?: () => void;
}

export function ApiKeyPanel({
  activeProvider,
  savedKeys,
  onValidated,
  onClear,
  onClose,
}: ApiKeyPanelProps) {
  const [provider, setProvider] = useState<ProviderId>(activeProvider);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentSaved = savedKeys[provider];

  const handleValidate = async (e: Event) => {
    e.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setErrorMsg("Please paste your API key first.");
      return;
    }

    setValidating(true);
    setErrorMsg(null);
    try {
      const resp = await fetch("/api/validate-key", {
        method: "POST",
        headers: {
          "X-Provider": provider,
          "X-API-Key": trimmed,
        },
      });
      const data = (await resp.json()) as {
        valid?: boolean;
        provider?: ProviderId;
        model?: string;
        maskedKey?: string;
        detail?: string;
        error?: string;
      };

      if (!resp.ok || !data.valid || !data.maskedKey || !data.model) {
        throw new Error(data.error || `Validation failed (HTTP ${resp.status})`);
      }

      const record: SavedCredential = {
        provider: data.provider ?? provider,
        apiKey: trimmed,
        maskedKey: data.maskedKey,
        model: data.model,
        detail: data.detail ?? "Verified",
        validatedAt: Date.now(),
      };
      await onValidated(record);
      setKeyInput("");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  };

  return (
    <section class="card key-panel">
      <div class="key-panel-header">
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: "1.05rem" }}>Bring Your Own Key (BYOK)</h2>
          <p class="muted" style={{ margin: 0 }}>
            Stored only in your browser&apos;s IndexedDB. Sent only via request headers. Never logged or stored on the
            server.
          </p>
        </div>
        {savedKeys[activeProvider] && onClose && (
          <button type="button" class="btn secondary" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      {currentSaved && (
        <div class="key-active-box">
          <div>
            <strong>
              {currentSaved.provider === "gemini" ? "Google Gemini API" : "OpenRouter (Jev)"} ✓{" "}
              <code>{currentSaved.maskedKey}</code>
            </strong>
            <div class="muted">
              Model: {currentSaved.model} · {currentSaved.detail}
            </div>
          </div>
          <button type="button" class="btn danger" onClick={() => void onClear(currentSaved.provider)}>
            Forget Key
          </button>
        </div>
      )}

      <form class="key-form" onSubmit={(e) => void handleValidate(e)}>
        <div class="provider-tabs">
          <button
            type="button"
            class={`btn secondary ${provider === "gemini" ? "active" : ""}`}
            onClick={() => {
              setProvider("gemini");
              setErrorMsg(null);
            }}
          >
            Gemini Key (H4 + D1) {savedKeys.gemini ? "✓" : ""}
          </button>
          <button
            type="button"
            class={`btn secondary ${provider === "jev" ? "active" : ""}`}
            onClick={() => {
              setProvider("jev");
              setErrorMsg(null);
            }}
          >
            OpenRouter Key (Jev 1.14) {savedKeys.jev ? "✓" : ""}
          </button>
        </div>

        <div class="key-input-row">
          <input
            type={showKey ? "text" : "password"}
            class="key-input"
            value={keyInput}
            onInput={(e) => setKeyInput((e.target as HTMLInputElement).value)}
            placeholder={
              provider === "gemini" ? "Paste AIza... Google Gemini API key" : "Paste sk-or-v1-... OpenRouter API key"
            }
            autocomplete="off"
            spellcheck={false}
          />
          <button type="button" class="btn secondary" onClick={() => setShowKey((v) => !v)}>
            {showKey ? "Hide" : "Show"}
          </button>
          <button type="submit" class="btn" disabled={validating}>
            {validating ? "Validating..." : "Validate & Save Key"}
          </button>
        </div>
      </form>

      {errorMsg && (
        <div class="error-banner" style={{ marginTop: "12px", marginBottom: 0 }}>
          {errorMsg}
        </div>
      )}
    </section>
  );
}
