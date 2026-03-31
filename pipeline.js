// src/pipeline.js
// Orchestrates the full fetch → cluster → save pipeline
// Runs every 15 minutes via cron

const { fetchAll } = require("./fetcher");
const { clusterArticles } = require("./clusterer");
const { saveStories } = require("./db");

let isRunning = false;
let lastRunAt = null;
let lastRunStats = null;

async function runPipeline() {
  if (isRunning) {
    console.log("[pipeline] Already running, skipping this tick");
    return;
  }

  isRunning = true;
  const startedAt = new Date();
  console.log(`\n[pipeline] ── Starting at ${startedAt.toISOString()} ──`);

  try {
    // Step 1: Fetch all RSS feeds
    const articles = await fetchAll();
    console.log(`[pipeline] Step 1 complete: ${articles.length} articles`);

    // Step 2: Cluster into stories
    const stories = clusterArticles(articles);
    console.log(`[pipeline] Step 2 complete: ${stories.length} stories`);

    // Step 3: Save to database
    let saved = 0;
    try {
      saved = await saveStories(stories);
      console.log(`[pipeline] Step 3 complete: ${saved} stories saved to DB`);
    } catch (dbErr) {
      // DB not configured — log but don't crash (useful for local testing)
      console.warn(`[pipeline] DB save skipped: ${dbErr.message}`);
      console.log("[pipeline] Stories available in memory only (configure Supabase to persist)");
    }

    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
    lastRunAt = startedAt;
    lastRunStats = {
      articlesFound: articles.length,
      storiesClustered: stories.length,
      storiesSaved: saved,
      durationSeconds: parseFloat(duration),
      completedAt: new Date().toISOString(),
    };

    console.log(`[pipeline] ── Done in ${duration}s ──\n`);

    // Return stories so the API can serve them from memory if DB isn't configured
    return stories;
  } catch (err) {
    console.error("[pipeline] Fatal error:", err);
    lastRunStats = { error: err.message, failedAt: new Date().toISOString() };
    return [];
  } finally {
    isRunning = false;
  }
}

function getStatus() {
  return {
    isRunning,
    lastRunAt: lastRunAt?.toISOString() || null,
    lastRunStats,
  };
}

module.exports = { runPipeline, getStatus };
