export type ProviderId = "gemini" | "jev";

export interface SignDefinition {
  id: string;
  label: string;
  prompt: string;
}

export interface BoundingBox {
  index: number;
  hintLabel: string;
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface DecisionResult {
  latencyMs: number;
  scores: Record<string, number>;
}

export interface AnalyzeResponse {
  localization: {
    latencyMs: number;
    boxes: BoundingBox[];
  };
  wholeImage: DecisionResult;
}

export interface SavedCredential {
  provider: ProviderId;
  apiKey: string;
  maskedKey: string;
  model: string;
  detail: string;
  validatedAt: number;
}
