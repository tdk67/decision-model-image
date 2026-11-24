import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

export interface SignDefinition {
  id: string;
  label: string;
  prompt: string;
}

export interface AppConfig {
  gemini: {
    apiKey: string;
    localizationModel: string;
    decisionModel: string;
    decisionApiVersion: string;
  };
  openrouter: {
    apiKey: string | null;
    model: string;
    decisionsUrl: string;
    timeoutSec: number;
  };
  ui: {
    defaultThresholdPct: number;
  };
  signs: SignDefinition[];
}

function requireField<T>(obj: Record<string, unknown>, key: string, section: string): T {
  const val = obj[key];
  if (val === undefined || val === null || val === "") {
    throw new Error(`Missing required config key '${section}.${key}' in config.json`);
  }
  return val as T;
}

export function loadConfig(): AppConfig {
  dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
  dotenv.config({ path: path.join(PROJECT_ROOT, "..", ".env") });

  const configPath = path.join(PROJECT_ROOT, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  const gRaw = requireField<Record<string, unknown>>(raw, "gemini", "root");
  const oRaw = requireField<Record<string, unknown>>(raw, "openrouter", "root");
  const uRaw = requireField<Record<string, unknown>>(raw, "ui", "root");

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY or GEMINI_API_KEY in .env");
  }
  const openRouterKey = process.env.OPEN_ROUTER_API_KEY || process.env.OPENROUTER_API_KEY || null;

  const signsPath = path.join(PROJECT_ROOT, "data", "traffic_signs.json");
  if (!fs.existsSync(signsPath)) {
    throw new Error(`Traffic signs taxonomy not found: ${signsPath}`);
  }
  const signsData = JSON.parse(fs.readFileSync(signsPath, "utf-8")) as { signs: SignDefinition[] };

  return {
    gemini: {
      apiKey,
      localizationModel: requireField<string>(gRaw, "localization_model", "gemini"),
      decisionModel: requireField<string>(gRaw, "decision_model", "gemini"),
      decisionApiVersion: requireField<string>(gRaw, "decision_api_version", "gemini"),
    },
    openrouter: {
      apiKey: openRouterKey,
      model: requireField<string>(oRaw, "model", "openrouter"),
      decisionsUrl: requireField<string>(oRaw, "decisions_url", "openrouter"),
      timeoutSec: Number(requireField<number>(oRaw, "timeout_sec", "openrouter")),
    },
    ui: {
      defaultThresholdPct: Number(requireField<number>(uRaw, "default_threshold_pct", "ui")),
    },
    signs: signsData.signs,
  };
}
