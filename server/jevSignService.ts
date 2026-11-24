import type { AppConfig } from "./config.js";
import { sanitizeError } from "./security.js";
import type {
  BoundingBox,
  DecisionResult,
  KeyValidationResult,
  LocalizationResult,
} from "./trafficSignService.js";

interface OpenRouterDecisionResponse {
  answers?: Record<
    string,
    {
      type?: string;
      noul?: number;
      box?: { top: number; bottom: number; left: number; right: number };
      confidence?: number;
    }
  >;
}

interface OpenRouterKeyInfoResponse {
  data?: {
    limit_remaining?: number | null;
    is_free_tier?: boolean;
  };
  error?: { message?: string };
}

export class JevSignService {
  private readonly config: AppConfig;
  private readonly noulQuestions: Record<string, Record<string, unknown>>;

  constructor(config: AppConfig) {
    this.config = config;
    const q: Record<string, Record<string, unknown>> = {};
    for (const sign of config.signs) {
      q[`sign_${sign.id}`] = {
        type: "noul",
        instructions: `Is ${sign.prompt} clearly visible in this image?`,
      };
    }
    this.noulQuestions = q;
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(10_000, this.config.openrouter.timeoutSec * 1000));
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
      const body = (await resp.json().catch(() => ({}))) as OpenRouterKeyInfoResponse;
      if (!resp.ok || body.error) {
        throw new Error(body.error?.message || `OpenRouter HTTP ${resp.status}`);
      }
      const remaining = body.data?.limit_remaining;
      const detail =
        typeof remaining === "number"
          ? `OpenRouter verified ($${remaining.toFixed(2)} remaining)`
          : "OpenRouter API verified";
      return {
        valid: true,
        provider: "jev",
        model: this.config.openrouter.model,
        detail,
      };
    } catch (err: unknown) {
      return {
        valid: false,
        provider: "jev",
        model: this.config.openrouter.model,
        detail: sanitizeError(err, apiKey),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async callDecisions(
    data: Buffer,
    mimeType: string,
    questions: Record<string, Record<string, unknown>>,
    apiKey: string
  ): Promise<OpenRouterDecisionResponse> {
    const b64 = data.toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.openrouter.timeoutSec * 1000);
    try {
      const resp = await fetch(this.config.openrouter.decisionsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "TypeSafe-Danger-Zone-Images": "true",
        },
        body: JSON.stringify({
          model: this.config.openrouter.model,
          state: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${b64}` },
            },
          ],
          questions,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`OpenRouter ${resp.status}: ${(await resp.text()).slice(0, 240)}`);
      }
      return (await resp.json()) as OpenRouterDecisionResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async classifySignsNoul(data: Buffer, mimeType: string, apiKey: string): Promise<DecisionResult> {
    const start = performance.now();
    const resp = await this.callDecisions(data, mimeType, this.noulQuestions, apiKey);
    const latencyMs = Math.round(performance.now() - start);

    const scores: Record<string, number> = {};
    const answers = resp.answers ?? {};
    for (const sign of this.config.signs) {
      const ans = answers[`sign_${sign.id}`];
      if (ans && ans.type === "noul" && typeof ans.noul === "number") {
        scores[sign.id] = Number(ans.noul.toFixed(4));
      }
    }
    return { latencyMs, scores };
  }

  async analyzeWithBoxes(
    data: Buffer,
    mimeType: string,
    apiKey: string
  ): Promise<{ localization: LocalizationResult; wholeImage: DecisionResult }> {
    const wholeImage = await this.classifySignsNoul(data, mimeType, apiKey);
    const candidates = this.config.signs.filter((s) => (wholeImage.scores[s.id] ?? 0) >= 0.45);

    const boxes: BoundingBox[] = [];
    let locLatencyMs = 0;

    if (candidates.length > 0) {
      const boxQuestions: Record<string, Record<string, unknown>> = {};
      for (const s of candidates) {
        boxQuestions[`box_${s.id}`] = {
          type: "box",
          instructions: `Locate ${s.prompt}`,
        };
      }
      const start = performance.now();
      const boxResp = await this.callDecisions(data, mimeType, boxQuestions, apiKey);
      locLatencyMs = Math.round(performance.now() - start);
      const answers = boxResp.answers ?? {};
      candidates.forEach((s) => {
        const ans = answers[`box_${s.id}`];
        if (ans && ans.type === "box" && ans.box) {
          boxes.push({
            index: boxes.length,
            hintLabel: s.label,
            ymin: Math.max(0, Math.min(1000, Math.round(ans.box.top * 1000))),
            xmin: Math.max(0, Math.min(1000, Math.round(ans.box.left * 1000))),
            ymax: Math.max(0, Math.min(1000, Math.round(ans.box.bottom * 1000))),
            xmax: Math.max(0, Math.min(1000, Math.round(ans.box.right * 1000))),
          });
        }
      });
    }

    return {
      localization: { latencyMs: locLatencyMs, boxes },
      wholeImage,
    };
  }
}
