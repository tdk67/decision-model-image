import express from "express";
import multer from "multer";
import { loadConfig } from "./config.js";
import { JevSignService } from "./jevSignService.js";
import { TrafficSignService } from "./trafficSignService.js";

const config = loadConfig();
const geminiService = new TrafficSignService(config);
const jevService = new JevSignService(config);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const app = express();
app.use(express.json());

app.get("/api/taxonomy", (_req, res) => {
  res.json({
    signs: config.signs,
    defaultThresholdPct: config.ui.defaultThresholdPct,
    providers: [
      { id: "gemini", label: "Gemini (H4 + D1)" },
      { id: "jev", label: "Jev 1.14 (OpenRouter)", enabled: Boolean(config.openrouter.apiKey) },
    ],
  });
});

app.post("/api/analyze", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Missing image file field 'image'" });
    return;
  }
  const provider = String(req.body?.provider || req.query.provider || "gemini");
  const mimeType = req.file.mimetype || "image/jpeg";
  try {
    if (provider === "jev") {
      const result = await jevService.analyzeWithBoxes(req.file.buffer, mimeType);
      res.json(result);
      return;
    }
    const [localization, wholeImage] = await Promise.all([
      geminiService.detectBoundaries(req.file.buffer, mimeType),
      geminiService.classifySignsNoul(req.file.buffer, mimeType),
    ]);
    res.json({ localization, wholeImage });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/classify-crop", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Missing cropped image field 'image'" });
    return;
  }
  const provider = String(req.body?.provider || req.query.provider || "gemini");
  const mimeType = req.file.mimetype || "image/png";
  try {
    const result =
      provider === "jev"
        ? await jevService.classifySignsNoul(req.file.buffer, mimeType)
        : await geminiService.classifySignsNoul(req.file.buffer, mimeType);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

const PORT = Number(process.env.PORT || 3002);
app.listen(PORT, () => {
  console.log(`Traffic Sign Categorizer server listening on http://localhost:${PORT}`);
});
