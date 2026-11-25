import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { loadConfig } from "./config.js";
import { JevSignService } from "./jevSignService.js";
import {
  extractCredentials,
  maskKey,
  sanitizeError,
  securityHeadersMiddleware,
} from "./security.js";
import { TrafficSignService } from "./trafficSignService.js";

const config = loadConfig();
const geminiService = new TrafficSignService(config);
const jevService = new JevSignService(config);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const app = express();
app.disable("x-powered-by");
app.use(securityHeadersMiddleware);
app.use(express.json({ limit: "64kb" }));

app.get("/api/taxonomy", (_req, res) => {
  res.json({
    signs: config.signs,
    defaultThresholdPct: config.ui.defaultThresholdPct,
    providers: [
      { id: "gemini", label: "Gemini (H4 + D1)" },
      { id: "jev", label: "Jev 1.14 (OpenRouter)" },
    ],
  });
});

app.post("/api/validate-key", async (req, res) => {
  const creds = extractCredentials(req);
  if ("error" in creds) {
    res.status(creds.status).json({ valid: false, error: creds.error });
    return;
  }

  const result =
    creds.provider === "jev"
      ? await jevService.validateKey(creds.apiKey)
      : await geminiService.validateKey(creds.apiKey);

  if (!result.valid) {
    res.status(401).json({ valid: false, error: result.detail });
    return;
  }

  res.json({
    valid: true,
    provider: result.provider,
    model: result.model,
    maskedKey: maskKey(creds.apiKey),
    detail: result.detail,
  });
});

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  const creds = extractCredentials(req);
  if ("error" in creds) {
    res.status(creds.status).json({ error: creds.error });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "Missing image file field 'image'" });
    return;
  }

  const mimeType = req.file.mimetype || "image/jpeg";
  try {
    if (creds.provider === "jev") {
      const result = await jevService.analyzeWithBoxes(req.file.buffer, mimeType, creds.apiKey);
      res.json(result);
      return;
    }
    const [localization, wholeImage] = await Promise.all([
      geminiService.detectBoundaries(req.file.buffer, mimeType, creds.apiKey),
      geminiService.classifySignsNoul(req.file.buffer, mimeType, creds.apiKey),
    ]);
    res.json({ localization, wholeImage });
  } catch (err: unknown) {
    res.status(500).json({ error: sanitizeError(err, creds.apiKey) });
  }
});

app.post("/api/classify-crop", upload.single("image"), async (req, res) => {
  const creds = extractCredentials(req);
  if ("error" in creds) {
    res.status(creds.status).json({ error: creds.error });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "Missing cropped image field 'image'" });
    return;
  }

  const mimeType = req.file.mimetype || "image/png";
  try {
    const result =
      creds.provider === "jev"
        ? await jevService.classifySignsNoul(req.file.buffer, mimeType, creds.apiKey)
        : await geminiService.classifySignsNoul(req.file.buffer, mimeType, creds.apiKey);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: sanitizeError(err, creds.apiKey) });
  }
});

// Serve the built Vite/Preact frontend (SPA) when present (production).
const __filenamedir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__filenamedir, "..", "dist");
if (fs.existsSync(path.join(distDir, "index.html"))) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Traffic Sign Categorizer server listening on http://${HOST}:${PORT} (BYOK mode)`);
});
