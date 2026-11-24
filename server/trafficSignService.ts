import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "./config.js";

export interface BoundingBox {
  index: number;
  hintLabel: string;
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface LocalizationResult {
  latencyMs: number;
  boxes: BoundingBox[];
}

export interface DecisionResult {
  latencyMs: number;
  scores: Record<string, number>;
}

const BOX_SCHEMA = {
  type: "object",
  properties: {
    signs: {
      type: "array",
      description: "All visible traffic signs in the image with normalized [0..1000] bounding boxes.",
      items: {
        type: "object",
        properties: {
          hintLabel: {
            type: "string",
            description: "Short visual description of the sign (e.g. 'red octagon', 'speed limit').",
          },
          ymin: { type: "number", description: "Top edge in [0, 1000]" },
          xmin: { type: "number", description: "Left edge in [0, 1000]" },
          ymax: { type: "number", description: "Bottom edge in [0, 1000]" },
          xmax: { type: "number", description: "Right edge in [0, 1000]" },
        },
        required: ["hintLabel", "ymin", "xmin", "ymax", "xmax"],
      },
    },
  },
  required: ["signs"],
};

export class TrafficSignService {
  private readonly interactionAi: GoogleGenAI;
  private readonly decisionAi: GoogleGenAI;
  private readonly config: AppConfig;
  private readonly questions: Record<string, Record<string, unknown>>;

  constructor(config: AppConfig) {
    this.config = config;
    this.interactionAi = new GoogleGenAI({
      apiKey: config.gemini.apiKey,
      apiVersion: config.gemini.decisionApiVersion,
    });
    this.decisionAi = new GoogleGenAI({
      apiKey: config.gemini.apiKey,
      apiVersion: config.gemini.decisionApiVersion,
    });

    const q: Record<string, Record<string, unknown>> = {};
    for (const sign of config.signs) {
      q[`sign_${sign.id}`] = {
        type: "noul",
        instructions: `Is ${sign.prompt} clearly visible in this image?`,
      };
    }
    this.questions = q;
  }

  async detectBoundaries(data: Buffer, mimeType: string): Promise<LocalizationResult> {
    const start = performance.now();
    const b64 = data.toString("base64");

    const interaction = await this.interactionAi.interactions.create({
      model: this.config.gemini.localizationModel,
      input: [
        {
          type: "text",
          text: "Locate every traffic sign in this image. Return tight bounding boxes using normalized coordinates from 0 to 1000 (ymin, xmin, ymax, xmax).",
        },
        {
          type: "image",
          data: b64,
          mime_type: mimeType,
        },
      ],
      response_format: BOX_SCHEMA as never,
    });

    const latencyMs = Math.round(performance.now() - start);
    const rawText = interaction.output_text ?? "{}";
    let parsed: { signs?: Array<Omit<BoundingBox, "index">> } = {};
    try {
      parsed = JSON.parse(rawText) as { signs?: Array<Omit<BoundingBox, "index">> };
    } catch {
      parsed = { signs: [] };
    }

    const boxes: BoundingBox[] = (parsed.signs ?? []).map((b, idx) => ({
      index: idx,
      hintLabel: String(b.hintLabel || `Sign #${idx + 1}`),
      ymin: Math.max(0, Math.min(1000, Number(b.ymin) || 0)),
      xmin: Math.max(0, Math.min(1000, Number(b.xmin) || 0)),
      ymax: Math.max(0, Math.min(1000, Number(b.ymax) || 0)),
      xmax: Math.max(0, Math.min(1000, Number(b.xmax) || 0)),
    }));

    return { latencyMs, boxes };
  }

  async classifySignsNoul(data: Buffer, mimeType: string): Promise<DecisionResult> {
    const start = performance.now();
    const b64 = data.toString("base64");

    const result = await this.decisionAi.decisions.create({
      model: this.config.gemini.decisionModel,
      input: [
        {
          type: "image",
          data: b64,
          mime_type: mimeType,
        },
      ],
      questions: this.questions as never,
    });

    const latencyMs = Math.round(performance.now() - start);
    const scores: Record<string, number> = {};
    const answers = result.answers ?? {};
    for (const sign of this.config.signs) {
      const ans = answers[`sign_${sign.id}`];
      if (ans && ans.type === "noul") {
        scores[sign.id] = Number(ans.noul.toFixed(4));
      }
    }
    return { latencyMs, scores };
  }
}

