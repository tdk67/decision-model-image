import { useEffect, useMemo, useState } from "preact/hooks";
import { ApiKeyPanel } from "./components/ApiKeyPanel";
import { clearSavedKey, loadSavedKeys, saveValidatedKey } from "./keyStore";
import type {
  AnalyzeResponse,
  BoundingBox,
  DecisionResult,
  ProviderId,
  SavedCredential,
  SignDefinition,
} from "./types";

async function cropBoxToBlob(imageUrl: string, box: BoundingBox): Promise<Blob> {
  const img = new Image();
  img.src = imageUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image for cropping"));
  });

  const pad = 0.08;
  const wNorm = Math.max(0.01, (box.xmax - box.xmin) / 1000);
  const hNorm = Math.max(0.01, (box.ymax - box.ymin) / 1000);
  const x0 = Math.max(0, box.xmin / 1000 - wNorm * pad) * img.naturalWidth;
  const y0 = Math.max(0, box.ymin / 1000 - hNorm * pad) * img.naturalHeight;
  const x1 = Math.min(1, box.xmax / 1000 + wNorm * pad) * img.naturalWidth;
  const y1 = Math.min(1, box.ymax / 1000 + hNorm * pad) * img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(x1 - x0));
  canvas.height = Math.max(1, Math.round(y1 - y0));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas crop failed"));
    }, "image/png");
  });
}

export function App() {
  const [signs, setSigns] = useState<SignDefinition[]>([]);
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [thresholdPct, setThresholdPct] = useState<number>(50);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<BoundingBox[]>([]);
  const [wholeResult, setWholeResult] = useState<DecisionResult | null>(null);
  const [cropResults, setCropResults] = useState<Map<number, DecisionResult>>(new Map());
  const [selectedBoxIdx, setSelectedBoxIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [locLatency, setLocLatency] = useState<number | null>(null);
  const [savedKeys, setSavedKeys] = useState<Partial<Record<ProviderId, SavedCredential>>>({});
  const [showKeyPanel, setShowKeyPanel] = useState<boolean>(false);

  useEffect(() => {
    void loadSavedKeys().then((keys) => {
      setSavedKeys(keys);
      if (!keys.gemini && !keys.jev) {
        setShowKeyPanel(true);
      } else if (!keys.gemini && keys.jev) {
        setProvider("jev");
      }
    });
  }, []);

  useEffect(() => {
    fetch("/api/taxonomy")
      .then((r) => r.json())
      .then((d: { signs: SignDefinition[]; defaultThresholdPct: number }) => {
        setSigns(d.signs ?? []);
        if (typeof d.defaultThresholdPct === "number") {
          setThresholdPct(d.defaultThresholdPct);
        }
      })
      .catch(() => setErrorMsg("Failed to load traffic sign taxonomy from /api/taxonomy"));
  }, []);

  const activeCred = savedKeys[provider] ?? null;

  const analyzeFile = async (
    file: File,
    activeProvider: ProviderId,
    localUrl: string,
    credOverride?: SavedCredential | null
  ) => {
    const cred = credOverride ?? savedKeys[activeProvider];
    if (!cred) {
      setShowKeyPanel(true);
      setErrorMsg(
        `No validated ${activeProvider === "gemini" ? "Google Gemini" : "OpenRouter (Jev)"} API key saved. Enter your key above first.`
      );
      return;
    }

    setBoxes([]);
    setWholeResult(null);
    setCropResults(new Map());
    setSelectedBoxIdx(null);
    setErrorMsg(null);
    setLoading(true);

    const authHeaders = {
      "X-Provider": activeProvider,
      "X-API-Key": cred.apiKey,
    };

    try {
      const form = new FormData();
      form.append("image", file);
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: authHeaders,
        body: form,
      });
      const data = (await resp.json()) as AnalyzeResponse & { error?: string };
      if (!resp.ok) {
        throw new Error(data.error || `Analyze failed (${resp.status})`);
      }

      setBoxes(data.localization.boxes);
      setLocLatency(data.localization.latencyMs);
      setWholeResult(data.wholeImage);
      setLoading(false);

      await Promise.all(
        data.localization.boxes.map(async (box) => {
          const blob = await cropBoxToBlob(localUrl, box);
          const cropForm = new FormData();
          cropForm.append("image", blob, `crop_${box.index}.png`);
          const cropResp = await fetch("/api/classify-crop", {
            method: "POST",
            headers: authHeaders,
            body: cropForm,
          });
          if (!cropResp.ok) return;
          const cropData = (await cropResp.json()) as DecisionResult;
          setCropResults((prev) => {
            const next = new Map(prev);
            next.set(box.index, cropData);
            return next;
          });
        })
      );
    } catch (err: unknown) {
      setLoading(false);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpload = async (file: File) => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const localUrl = URL.createObjectURL(file);
    setUploadedFile(file);
    setImageUrl(localUrl);
    await analyzeFile(file, provider, localUrl);
  };

  const handleProviderChange = async (nextProvider: ProviderId) => {
    setProvider(nextProvider);
    setErrorMsg(null);
    const cred = savedKeys[nextProvider];
    if (!cred) {
      setShowKeyPanel(true);
      return;
    }
    if (uploadedFile && imageUrl) {
      await analyzeFile(uploadedFile, nextProvider, imageUrl, cred);
    }
  };

  const handleKeyValidated = async (cred: SavedCredential) => {
    await saveValidatedKey(cred);
    setSavedKeys((prev) => ({ ...prev, [cred.provider]: cred }));
    setProvider(cred.provider);
    setShowKeyPanel(false);
    setErrorMsg(null);
    if (uploadedFile && imageUrl) {
      await analyzeFile(uploadedFile, cred.provider, imageUrl, cred);
    }
  };

  const handleClearKey = async (targetProvider: ProviderId) => {
    await clearSavedKey(targetProvider);
    setSavedKeys((prev) => {
      const next = { ...prev };
      delete next[targetProvider];
      return next;
    });
    if (targetProvider === provider) {
      setShowKeyPanel(true);
    }
  };

  const activeDecision: DecisionResult | null =
    selectedBoxIdx !== null ? cropResults.get(selectedBoxIdx) ?? wholeResult : wholeResult;

  const sortedSigns = useMemo(() => {
    const scores = activeDecision?.scores ?? {};
    return [...signs].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0));
  }, [signs, activeDecision]);

  const activeCount = useMemo(() => {
    const scores = activeDecision?.scores ?? {};
    return signs.filter((s) => (scores[s.id] ?? 0) * 100 >= thresholdPct).length;
  }, [signs, activeDecision, thresholdPct]);

  const getBoxBest = (box: BoundingBox): { label: string; score: number } => {
    const crop = cropResults.get(box.index);
    if (!crop) return { label: box.hintLabel, score: 0 };
    let bestId = "";
    let bestScore = -1;
    for (const [id, score] of Object.entries(crop.scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }
    const def = signs.find((s) => s.id === bestId);
    return {
      label: def ? `${def.label} (${Math.round(bestScore * 100)}%)` : box.hintLabel,
      score: Math.max(0, bestScore),
    };
  };

  const sortedBoxes = useMemo(() => {
    return [...boxes].sort((a, b) => getBoxBest(b).score - getBoxBest(a).score);
  }, [boxes, cropResults, signs]);

  const visibleBoxes = useMemo(() => {
    if (selectedBoxIdx === null) return boxes;
    return boxes.filter((b) => b.index === selectedBoxIdx);
  }, [boxes, selectedBoxIdx]);

  return (
    <div class="shell">
      <header class="header">
        <h1>
          Traffic Sign Categorizer — {provider === "gemini" ? "Gemini (H4 + D1)" : "Jev 1.14 (OpenRouter)"} (
          {signs.length} noul signs)
        </h1>
        <span class="muted">
          {loading
            ? "Detecting boundaries & evaluating signs..."
            : locLatency !== null
              ? `Boxes: ${boxes.length} (${locLatency} ms) | Decision: ${activeDecision?.latencyMs ?? "—"} ms`
              : "Upload a street photo to begin"}
        </span>
      </header>

      {errorMsg && <div class="error-banner">{errorMsg}</div>}

      {(showKeyPanel || !activeCred) && (
        <ApiKeyPanel
          activeProvider={provider}
          savedKeys={savedKeys}
          onValidated={handleKeyValidated}
          onClear={handleClearKey}
          onClose={() => setShowKeyPanel(false)}
        />
      )}

      <section class="card toolbar">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
          <label class="btn">
            Upload Street Picture
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) void handleUpload(file);
              }}
            />
          </label>

          <button
            type="button"
            class={`btn secondary ${provider === "gemini" ? "active" : ""}`}
            onClick={() => void handleProviderChange("gemini")}
          >
            Gemini (H4 + D1) {savedKeys.gemini ? "✓" : ""}
          </button>
          <button
            type="button"
            class={`btn secondary ${provider === "jev" ? "active" : ""}`}
            onClick={() => void handleProviderChange("jev")}
          >
            Jev 1.14 (OpenRouter) {savedKeys.jev ? "✓" : ""}
          </button>
          <button
            type="button"
            class="btn secondary"
            onClick={() => setShowKeyPanel((v) => !v)}
          >
            {activeCred ? `API Key (${activeCred.maskedKey})` : "Set API Key"}
          </button>
        </div>

        <div class="slider-box">
          <label for="conf-slider">
            <span>Confidence Threshold</span>
            <strong>{thresholdPct}%</strong>
          </label>
          <input
            id="conf-slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={thresholdPct}
            onInput={(e) => setThresholdPct(Number((e.target as HTMLInputElement).value))}
          />
        </div>
      </section>

      <main class="workspace-grid">
        <section class="card">
          <div class="list-header">
            <strong>Picture &amp; Sign Boundaries</strong>
            <span class="muted">Click a box to inspect its crop</span>
          </div>

          <div class="image-stage">
            {imageUrl ? (
              <>
                <img src={imageUrl} alt="Uploaded street scene" />
                {visibleBoxes.map((box) => {
                  const isSelected = selectedBoxIdx === box.index;
                  return (
                    <div
                      key={box.index}
                      class={`bbox ${isSelected ? "selected" : ""}`}
                      style={{
                        top: `${box.ymin / 10}%`,
                        left: `${box.xmin / 10}%`,
                        height: `${(box.ymax - box.ymin) / 10}%`,
                        width: `${(box.xmax - box.xmin) / 10}%`,
                      }}
                      onClick={() => setSelectedBoxIdx(box.index)}
                    >
                      <span class="bbox-label">
                        #{box.index + 1} {getBoxBest(box).label}
                      </span>
                    </div>
                  );
                })}
              </>
            ) : (
              <div style={{ padding: "110px 20px", textAlign: "center" }} class="muted">
                Upload an image containing one or more traffic signs.
              </div>
            )}
          </div>

          {boxes.length > 0 && (
            <div class="chip-row">
              <button
                type="button"
                class={`btn secondary ${selectedBoxIdx === null ? "active" : ""}`}
                onClick={() => setSelectedBoxIdx(null)}
              >
                Whole Image
              </button>
              {sortedBoxes.map((box) => {
                const best = getBoxBest(box);
                const isBelow = Math.round(best.score * 100) < thresholdPct;
                return (
                  <button
                    key={box.index}
                    type="button"
                    class={`btn secondary ${selectedBoxIdx === box.index ? "active" : ""}`}
                    style={isBelow ? { opacity: 0.4 } : undefined}
                    onClick={() => setSelectedBoxIdx(box.index)}
                  >
                    #{box.index + 1} {best.label}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section class="card">
          <div class="list-header">
            <strong>
              {selectedBoxIdx !== null ? `Crop #${selectedBoxIdx + 1} Decisions` : "Whole Image Decisions"}
            </strong>
            <span class="muted">
              {activeDecision ? `${activeCount} / ${signs.length} >= ${thresholdPct}%` : "Waiting..."}
            </span>
          </div>

          <div class="sign-list">
            {sortedSigns.map((sign) => {
              const pct = Math.round((activeDecision?.scores[sign.id] ?? 0) * 100);
              const isAbove = pct >= thresholdPct;
              return (
                <div key={sign.id} class={`sign-row ${isAbove ? "above" : "below"}`}>
                  <span class="sign-name" title={sign.label}>
                    {sign.label}
                  </span>
                  <div class="bar-track">
                    <div class="bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span class="sign-pct">{pct}%</span>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
