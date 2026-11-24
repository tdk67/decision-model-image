import type express from "express";

export type ProviderId = "gemini" | "jev";

export interface ExtractedCredentials {
  provider: ProviderId;
  apiKey: string;
}

export interface CredentialExtractionError {
  status: number;
  error: string;
}

const KEY_FORMAT_REGEX = /^[\x21-\x7E]{16,256}$/;
const FORBIDDEN_QUERY_PARAMS = ["key", "apiKey", "api_key", "token"];

export function sanitizeError(err: unknown, secretKey?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (secretKey && secretKey.length >= 6) {
    msg = msg.split(secretKey).join("[REDACTED]");
  }
  msg = msg
    .replace(/AIza[0-9A-Za-z_-]{16,}/g, "[REDACTED]")
    .replace(/sk-or-v1-[0-9a-fA-F]{16,}/g, "[REDACTED]")
    .replace(/sk-[0-9A-Za-z_-]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:key|apiKey|api_key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();

  if (msg.length > 220) {
    return `${msg.slice(0, 217)}...`;
  }
  return msg || "Upstream request failed";
}

export function extractCredentials(
  req: express.Request
): ExtractedCredentials | CredentialExtractionError {
  for (const param of FORBIDDEN_QUERY_PARAMS) {
    if (req.query[param] !== undefined) {
      return {
        status: 400,
        error: "API keys must be sent in request headers, never in URL query parameters.",
      };
    }
  }

  const rawKey = req.header("x-api-key");
  if (!rawKey || !rawKey.trim()) {
    return {
      status: 401,
      error: "Missing X-API-Key header. Enter and validate your own Google or OpenRouter API key first.",
    };
  }

  const apiKey = rawKey.trim();
  if (!KEY_FORMAT_REGEX.test(apiKey)) {
    return {
      status: 400,
      error: "Invalid X-API-Key format (must be 16-256 printable ASCII characters with no spaces).",
    };
  }

  const rawProvider = String(req.header("x-provider") ?? "gemini").trim().toLowerCase();
  if (rawProvider !== "gemini" && rawProvider !== "jev") {
    return {
      status: 400,
      error: "Invalid X-Provider header. Supported providers: 'gemini' or 'jev'.",
    };
  }

  return { provider: rawProvider, apiKey };
}

export function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

export function securityHeadersMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );

  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
}
