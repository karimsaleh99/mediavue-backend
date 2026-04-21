// src/ask.js
// Ask MV — premium AI Q&A grounded in tracked French sources.
//
// Routes (all premium-only):
//   POST /api/ask           — streaming answer (SSE)
//   GET  /api/ask/history   — recent queries for the authenticated user
//   POST /api/ask/suggest   — suggested follow-up questions for a story
//
// Contract:
//   - Answers cite sources inline as [1], [2] referencing a numbered list
//     we build server-side from retrieved articles.
//   - When a comparison would be clearer as a chart, Claude emits a fenced
//     ```mv-chart block with {type,title,data[]} the UI renders.
//   - Refuses to answer when sources don't cover the question (no hallucinated
//     opinions — the neutrality principle).

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const { SOURCES } = require("./sources");

const router = express.Router();

let anthropic;
function getAnthropic() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

let supabase;
function getDb() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabase;
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function requirePremium(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing bearer token" });

    const db = getDb();
    const { data: { user }, error } = await db.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });

    const { data: profile } = await db
      .from("profiles")
      .select("is_premium, premium_plan")
      .eq("id", user.id)
      .single();

    if (!profile?.is_premium) {
      return res.status(402).json({ error: "Premium required", upgrade: true });
    }

    req.user = user;
    req.profile = profile;
    next();
  } catch (err) {
    console.error("[ask] auth error:", err.message);
    res.status(500).json({ error: "Auth check failed" });
  }
}

// ── Rate limit (crude in-memory; swap for Redis later) ──────────────────────

const usage = new Map(); // userId -> { count, resetAt }
const DAILY_LIMITS = { monthly: 100, annual: 200, student: 50 };

function checkLimit(userId, plan) {
  const limit = DAILY_LIMITS[plan] || 50;
  const now = Date.now();
  const entry = usage.get(userId);
  if (!entry || entry.resetAt < now) {
    usage.set(userId, { count: 1, resetAt: now + 24 * 60 * 60 * 1000 });
    return { ok: true, remaining: limit - 1 };
  }
  if (entry.count >= limit) return { ok: false, remaining: 0 };
  entry.count++;
  return { ok: true, remaining: limit - entry.count };
}

// ── Retrieval (MVP: keyword search; v2 = pgvector) ──────────────────────────

async function retrieveContext(question, { limit = 8 } = {}) {
  const db = getDb();
  const keywords = question
    .toLowerCase()
    .replace(/[^\w\sàâäéèêëïîôöùûüç]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);

  if (keywords.length === 0) return [];

  const pattern = keywords.map((k) => `%${k}%`).join(",");
  const { data: stories } = await db
    .from("stories")
    .select("id,title,summary,published_at,category,source_ids,coverage_by_orientation")
    .or(keywords.map((k) => `title.ilike.%${k}%,summary.ilike.%${k}%`).join(","))
    .order("published_at", { ascending: false })
    .limit(limit);

  if (!stories?.length) return [];

  const storyIds = stories.map((s) => s.id);
  const { data: articles } = await db
    .from("articles")
    .select("id,story_id,source_id,title,summary,url,published_at,orientation,orientation_score")
    .in("story_id", storyIds)
    .order("published_at", { ascending: false })
    .limit(40);

  return stories.map((s) => ({
    ...s,
    articles: (articles || []).filter((a) => a.story_id === s.id),
  }));
}

// ── Prompt construction ─────────────────────────────────────────────────────

function sourcesRegistryBlock() {
  // Compact registry Claude can reference. Kept deterministic for cache hits.
  return SOURCES.map((s) =>
    `- ${s.id} (${s.name}): bias=${s.bias}, factuality=${s.factuality}, owner=${s.ownership?.group || "indép."}`
  ).join("\n");
}

function buildSystemBlocks() {
  return [
    {
      type: "text",
      text: `You are Ask MV, the analytical assistant inside MédiaVue, a French media-bias aggregation platform.

Your non-negotiable rules:
1. Neutrality. Never take sides. Describe how outlets across the spectrum frame a story; do not endorse any framing.
2. Cite or refuse. Every factual claim about French news MUST reference a numbered source from the CONTEXT block. If the context does not cover the question, say so plainly and suggest what to track.
3. Symmetric blindspots. When one side of the spectrum under-covers a story, name that explicitly — that is the product's core value.
4. French bias scale: -3 (far-left) to +3 (far-right). Factuality: 0-100.
5. When a comparison would be clearer as a chart, emit a fenced \`\`\`mv-chart block with JSON:
   { "type": "bar"|"donut"|"timeline", "title": "...", "data": [{"label":"...","value":N,"color":"#..."}] }
6. Answer in the user's language (default French). Keep answers tight — this is a news brief, not an essay.`,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `FRENCH MEDIA SOURCES REGISTRY\n\n${sourcesRegistryBlock()}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function buildContextBlock(stories) {
  if (!stories.length) {
    return "CONTEXT: no matching stories in the last 14 days.";
  }
  const lines = ["CONTEXT (numbered sources you may cite as [n]):\n"];
  let n = 1;
  const index = [];
  for (const story of stories) {
    lines.push(`## Story: ${story.title}`);
    lines.push(`Published: ${story.published_at} | Category: ${story.category || "n/a"}`);
    if (story.summary) lines.push(`Summary: ${story.summary}`);
    lines.push(`Coverage by orientation: ${JSON.stringify(story.coverage_by_orientation || {})}`);
    for (const a of story.articles) {
      lines.push(
        `[${n}] ${a.source_id} (orientation ${a.orientation_score ?? "?"}): "${a.title}" — ${a.url}`
      );
      if (a.summary) lines.push(`    ${a.summary.slice(0, 400)}`);
      index.push({ n, articleId: a.id, sourceId: a.source_id, url: a.url, title: a.title });
      n++;
    }
    lines.push("");
  }
  return { text: lines.join("\n"), index };
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.post("/", requirePremium, async (req, res) => {
  const { question, history = [] } = req.body || {};
  if (!question || typeof question !== "string" || question.length < 3) {
    return res.status(400).json({ error: "Question is required" });
  }
  if (question.length > 2000) {
    return res.status(400).json({ error: "Question too long (max 2000 chars)" });
  }

  const limit = checkLimit(req.user.id, req.profile.premium_plan);
  if (!limit.ok) {
    return res.status(429).json({ error: "Daily limit reached", remaining: 0 });
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    send("status", { phase: "retrieving" });
    const stories = await retrieveContext(question);
    const ctx = buildContextBlock(stories);
    const contextText = typeof ctx === "string" ? ctx : ctx.text;
    const citationIndex = typeof ctx === "string" ? [] : ctx.index;

    send("citations", { sources: citationIndex, remaining: limit.remaining });
    send("status", { phase: "thinking" });

    const messages = [
      ...history.slice(-6).map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      {
        role: "user",
        content: `${contextText}\n\n---\n\nQUESTION: ${question}`,
      },
    ];

    const stream = await getAnthropic().messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 2048,
      system: buildSystemBlocks(),
      messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });

    let tokensIn = 0;
    let tokensOut = 0;
    let fullText = "";

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullText += event.delta.text;
        send("delta", { text: event.delta.text });
      } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
        send("thinking", { text: event.delta.text });
      } else if (event.type === "message_delta" && event.usage) {
        tokensOut = event.usage.output_tokens || tokensOut;
      } else if (event.type === "message_start" && event.message?.usage) {
        tokensIn = event.message.usage.input_tokens || 0;
      }
    }

    const final = await stream.finalMessage();
    const usageData = final.usage || {};

    // Log the query
    try {
      await getDb().from("ask_queries").insert({
        user_id: req.user.id,
        question,
        answer: fullText,
        citations: citationIndex,
        tokens_in: usageData.input_tokens || tokensIn,
        tokens_out: usageData.output_tokens || tokensOut,
        cache_read_tokens: usageData.cache_read_input_tokens || 0,
        cache_write_tokens: usageData.cache_creation_input_tokens || 0,
      });
    } catch (logErr) {
      console.warn("[ask] query log failed:", logErr.message);
    }

    send("done", {
      usage: {
        in: usageData.input_tokens,
        out: usageData.output_tokens,
        cacheRead: usageData.cache_read_input_tokens,
      },
      remaining: limit.remaining,
    });
    res.end();
  } catch (err) {
    console.error("[ask] error:", err);
    send("error", { message: err.message || "Ask failed" });
    res.end();
  }
});

router.get("/history", requirePremium, async (req, res) => {
  try {
    const { data } = await getDb()
      .from("ask_queries")
      .select("id,question,answer,citations,created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    res.json({ queries: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/suggest", requirePremium, async (req, res) => {
  const { storyId } = req.body || {};
  if (!storyId) return res.status(400).json({ error: "storyId required" });

  try {
    const db = getDb();
    const { data: story } = await db
      .from("stories")
      .select("title,summary,category")
      .eq("id", storyId)
      .single();

    if (!story) return res.status(404).json({ error: "Story not found" });

    const resp = await getAnthropic().messages.create({
      model: "claude-opus-4-7",
      max_tokens: 400,
      system: "Generate 3 short, specific follow-up questions a French news reader would ask about this story. Respond as a JSON array of strings. No preamble.",
      messages: [
        {
          role: "user",
          content: `Story: ${story.title}\nSummary: ${story.summary}\nCategory: ${story.category}`,
        },
      ],
      thinking: { type: "adaptive" },
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 3,
          },
        },
      },
    });

    const text = resp.content.find((b) => b.type === "text")?.text || "[]";
    res.json({ suggestions: JSON.parse(text) });
  } catch (err) {
    console.error("[ask] suggest error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
