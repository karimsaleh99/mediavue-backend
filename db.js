// src/db.js
// Supabase client + helpers for reading and writing stories/articles
// Run the SQL in supabase-schema.sql first to create the tables

const { createClient } = require("@supabase/supabase-js");

let supabase = null;

function getClient() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment. Copy .env.example to .env and fill in your values."
      );
    }
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabase;
}

// Upsert stories (insert or update based on title + date match)
async function saveStories(stories) {
  const db = getClient();
  let saved = 0;

  for (const story of stories) {
    // Upsert the story
    const { data: storyRow, error: storyErr } = await db
      .from("stories")
      .upsert(
        {
          title: story.title,
          summary: story.summary,
          published_at: story.publishedAt,
          coverage_count: story.coverageCount,
          source_ids: story.sourceIds,
          coverage_by_orientation: story.coverageByOrientation,
          blindspot: story.blindspot,
          category: story.category,
          updated_at: new Date(),
        },
        { onConflict: "title", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (storyErr) {
      console.error(`[db] Story upsert failed: ${storyErr.message}`);
      continue;
    }

    // Upsert each article linked to this story
    const articleRows = story.articles.map((a) => ({
      story_id: storyRow.id,
      source_id: a.sourceId,
      title: a.title,
      summary: a.summary,
      url: a.url,
      image_url: a.imageUrl,
      published_at: a.publishedAt,
      orientation: a.orientation,
      orientation_score: a.orientationScore,
    }));

    const { error: artErr } = await db
      .from("articles")
      .upsert(articleRows, { onConflict: "url", ignoreDuplicates: true });

    if (artErr) {
      console.error(`[db] Article upsert failed: ${artErr.message}`);
    }

    saved++;
  }

  console.log(`[db] Saved ${saved}/${stories.length} stories`);
  return saved;
}

// Get latest stories for the feed
async function getStories({ limit = 20, offset = 0, category = null } = {}) {
  const db = getClient();
  let query = db
    .from("stories")
    .select(`
      id, title, summary, published_at, coverage_count,
      source_ids, coverage_by_orientation, blindspot, category, updated_at
    `)
    .order("coverage_count", { ascending: false })
    .order("published_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Get a single story with its articles
async function getStoryById(id) {
  const db = getClient();
  const { data: story, error: storyErr } = await db
    .from("stories")
    .select("*")
    .eq("id", id)
    .single();

  if (storyErr) throw storyErr;

  const { data: articles, error: artErr } = await db
    .from("articles")
    .select("*")
    .eq("story_id", id)
    .order("published_at", { ascending: false });

  if (artErr) throw artErr;

  return { ...story, articles };
}

module.exports = { getClient, saveStories, getStories, getStoryById };
