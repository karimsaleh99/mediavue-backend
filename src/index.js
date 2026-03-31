// src/index.js
// MédiaVue API server
// Routes:
//   GET /api/stories          — feed (latest stories, sorted by coverage)
//   GET /api/stories/:id      — single story with all articles
//   GET /api/sources          — all sources with bias/ownership data
//   GET /api/status           — pipeline health check
//   POST /api/pipeline/run    — manually trigger a pipeline run

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { runPipeline, getStatus } = require("./pipeline");
const { getStories, getStoryById } = require("./db");
const { SOURCES } = require("./sources");

const app = express();
const PORT = process.env.PORT || 3001;

// In-memory story cache (fallback when DB isn't configured yet)
let memoryCache = [];
let cacheUpdatedAt = null;

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(cors({
 origin: "*",
}));
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`[api] ${req.method} ${req.path}`);
  next();
});

// ── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get("/", (_req, res) => {
  res.json({
    name: "MédiaVue API",
    version: "1.0.0",
    status: "ok",
    docs: "https://github.com/your-repo/mediavue-backend#api",
  });
});

// Pipeline status
app.get("/api/status", (_req, res) => {
  res.json({
    pipeline: getStatus(),
    cache: {
      stories: memoryCache.length,
      updatedAt: cacheUpdatedAt,
    },
  });
});

// Manually trigger a pipeline run (useful during development)
app.post("/api/pipeline/run", async (_req, res) => {
  res.json({ message: "Pipeline started — check /api/status for progress" });
  const stories = await runPipeline();
  if (stories.length > 0) {
    memoryCache = stories;
    cacheUpdatedAt = new Date().toISOString();
  }
});

// GET /api/stories — main feed
app.get("/api/stories", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const category = req.query.category || null;

    // Try DB first, fall back to memory cache
    let stories;
    try {
      stories = await getStories({ limit, offset, category });
    } catch {
      console.warn("[api] DB unavailable, serving from memory cache");
      stories = applyMemoryFilters(memoryCache, { limit, offset, category });
    }

    res.json({
      stories,
      meta: {
        limit,
        offset,
        count: stories.length,
        source: stories === memoryCache ? "cache" : "db",
      },
    });
  } catch (err) {
    console.error("[api] /stories error:", err.message);
    res.status(500).json({ error: "Failed to fetch stories" });
  }
});

// GET /api/stories/:id — single story with articles
app.get("/api/stories/:id", async (req, res) => {
  try {
    const story = await getStoryById(req.params.id);
    res.json(story);
  } catch (err) {
    // Try memory cache
    const cached = memoryCache.find((s) => s.id === req.params.id);
    if (cached) return res.json(cached);
    console.error("[api] /stories/:id error:", err.message);
    res.status(404).json({ error: "Story not found" });
  }
});

// GET /api/sources — all sources with bias + ownership metadata
app.get("/api/sources", (_req, res) => {
  res.json({
    sources: SOURCES,
    meta: { count: SOURCES.length, updatedAt: "2026-03-31" },
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function applyMemoryFilters(stories, { limit, offset, category }) {
  let filtered = stories;
  if (category) filtered = filtered.filter((s) => s.category === category);
  return filtered.slice(offset, offset + limit);
}

// ── Cron + startup ───────────────────────────────────────────────────────────

async function start() {
  console.log("╔═══════════════════════════════════╗");
  console.log("║       MédiaVue Backend v1.0       ║");
  console.log("╚═══════════════════════════════════╝");

  // Run pipeline immediately on startup
  console.log("[startup] Running initial pipeline...");
  const stories = await runPipeline();
  if (stories.length > 0) {
    memoryCache = stories;
    cacheUpdatedAt = new Date().toISOString();
    console.log(`[startup] ${stories.length} stories cached in memory`);
  }

  // Schedule pipeline every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    console.log("[cron] Triggering scheduled pipeline run");
    const updated = await runPipeline();
    if (updated.length > 0) {
      memoryCache = updated;
      cacheUpdatedAt = new Date().toISOString();
    }
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
    console.log(`[server] API ready at http://localhost:${PORT}/api/stories`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
