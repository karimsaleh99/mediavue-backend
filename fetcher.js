// src/fetcher.js
// Polls all RSS feeds and normalises articles into a standard shape

const Parser = require("rss-parser");
const { SOURCES } = require("./sources");

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "MédiaVue/1.0 (aggregateur de presse française; contact@mediavue.fr)",
    Accept: "application/rss+xml, application/xml, text/xml",
  },
  customFields: {
    item: [
      ["media:content", "mediaContent"],
      ["media:thumbnail", "mediaThumbnail"],
      ["dc:creator", "creator"],
    ],
  },
});

// Fetch and normalise a single source
async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const articles = (feed.items || []).slice(0, 30).map((item) => ({
      id: null,                                       // set by DB
      sourceId: source.id,
      sourceName: source.name,
      title: cleanText(item.title),
      summary: cleanText(item.contentSnippet || item.summary || ""),
      url: item.link || item.guid,
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      imageUrl: extractImage(item),
      categories: (item.categories || []).map((c) => c.toLowerCase()),
      clusterId: null,                                // set by clusterer
      orientation: source.orientation,
      orientationScore: source.orientationScore,
    }));

    console.log(`[fetcher] ${source.name}: ${articles.length} articles`);
    return { source, articles, error: null };
  } catch (err) {
    console.error(`[fetcher] ${source.name} failed: ${err.message}`);
    return { source, articles: [], error: err.message };
  }
}

// Fetch all sources in parallel
async function fetchAll() {
  console.log(`[fetcher] Starting fetch for ${SOURCES.length} sources...`);
  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  const articles = [];

  results.forEach((result) => {
    if (result.status === "fulfilled") {
      articles.push(...result.value.articles);
    }
  });

  console.log(`[fetcher] Total articles fetched: ${articles.length}`);
  return articles;
}

// Strip HTML tags and extra whitespace
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

// Extract best available image
function extractImage(item) {
  if (item.mediaContent?.["$"]?.url) return item.mediaContent["$"].url;
  if (item.mediaThumbnail?.["$"]?.url) return item.mediaThumbnail["$"].url;
  const imgMatch = (item.content || "").match(/<img[^>]+src="([^"]+)"/);
  if (imgMatch) return imgMatch[1];
  return null;
}

module.exports = { fetchAll, fetchSource };
