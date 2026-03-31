// src/clusterer.js
// Groups articles about the same event using TF-IDF cosine similarity
// This is the "brain" of MédiaVue — finding that Le Monde's "Manifestations retraites"
// and Libération's "Grève nationale" are the same story.
//
// How it works:
// 1. Build a TF-IDF vector for each article title
// 2. Compute cosine similarity between all pairs
// 3. Group articles above the similarity threshold into clusters
// 4. Each cluster becomes one "story card" in the app

const natural = require("natural");

const TfIdf = natural.TfIdf;
const SIMILARITY_THRESHOLD = 0.20; // tune this — lower = more aggressive grouping
const MAX_CLUSTER_AGE_HOURS = 24;  // don't cluster articles more than 24h apart

// French stopwords to filter out before comparing
const FRENCH_STOPWORDS = new Set([
  "le","la","les","un","une","des","du","de","d","l","en","et","est","au","aux",
  "ce","se","sa","son","ses","sur","par","pour","dans","avec","qui","que","qu",
  "pas","ne","je","il","elle","ils","elles","nous","vous","on","y","à","a","ou",
  "mais","donc","or","ni","car","tout","tous","très","plus","bien","après","avant",
  "lors","selon","face","contre","entre","vers","depuis","jusqu",
]);

// Tokenise and clean a French title
function tokenise(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // remove accents for matching
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !FRENCH_STOPWORDS.has(w));
}

// Compute cosine similarity between two TF-IDF document vectors
function cosineSimilarity(tfidf, docA, docB) {
  const termsA = {};
  const termsB = {};

  tfidf.listTerms(docA).forEach(({ term, tfidf: score }) => {
    termsA[term] = score;
  });
  tfidf.listTerms(docB).forEach(({ term, tfidf: score }) => {
    termsB[term] = score;
  });

  const allTerms = new Set([...Object.keys(termsA), ...Object.keys(termsB)]);
  let dot = 0, normA = 0, normB = 0;

  allTerms.forEach((term) => {
    const a = termsA[term] || 0;
    const b = termsB[term] || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  });

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Check if two articles are close enough in time to be the same story
function withinTimeWindow(articleA, articleB) {
  const diffMs = Math.abs(
    new Date(articleA.publishedAt) - new Date(articleB.publishedAt)
  );
  return diffMs < MAX_CLUSTER_AGE_HOURS * 60 * 60 * 1000;
}

// Main clustering function
function clusterArticles(articles) {
  if (articles.length === 0) return [];

  // Build TF-IDF model from all article titles
  const tfidf = new TfIdf();
  articles.forEach((article) => {
    tfidf.addDocument(tokenise(article.title));
  });

  // Union-Find for clustering
  const parent = articles.map((_, i) => i);

  function find(i) {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }

  function union(i, j) {
    parent[find(i)] = find(j);
  }

  // Compare all pairs — O(n²), fine for <500 articles per run
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      // Skip if same source (one outlet = one article per cluster)
      if (articles[i].sourceId === articles[j].sourceId) continue;
      // Skip if too far apart in time
      if (!withinTimeWindow(articles[i], articles[j])) continue;

      const similarity = cosineSimilarity(tfidf, i, j);
      if (similarity >= SIMILARITY_THRESHOLD) {
        union(i, j);
      }
    }
  }

  // Group by cluster root
  const clusters = {};
  articles.forEach((article, i) => {
    const root = find(i);
    if (!clusters[root]) clusters[root] = [];
    clusters[root].push(article);
  });

  // Build story objects from clusters
  const stories = Object.values(clusters)
    .filter((group) => group.length >= 1)
    .map((group) => {
      // Sort by number of sources (most covered first), then by date
      group.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

      const sourceIds = [...new Set(group.map((a) => a.sourceId))];
      const coverageByOrientation = countCoverage(group);
      const blindspot = detectBlindspot(coverageByOrientation, sourceIds);

      return {
        id: null,                     // set by DB
        title: group[0].title,        // use the most recent article's title
        summary: group[0].summary,
        publishedAt: group[0].publishedAt,
        coverageCount: sourceIds.length,
        sourceIds,
        coverageByOrientation,
        blindspot,
        articles: group,
        category: inferCategory(group),
      };
    })
    .sort((a, b) => b.coverageCount - a.coverageCount); // most covered stories first

  console.log(
    `[clusterer] ${articles.length} articles → ${stories.length} stories`
  );
  return stories;
}

// Count how many gauche/centre/droite sources cover this story
function countCoverage(articles) {
  const counts = { gauche: 0, centre: 0, droite: 0 };
  const seen = new Set();

  articles.forEach((article) => {
    if (seen.has(article.sourceId)) return;
    seen.add(article.sourceId);

    const score = article.orientationScore;
    if (score <= 1) counts.gauche++;
    else if (score <= 3) counts.centre++;
    else counts.droite++;
  });

  return counts;
}

// Detect which side of the spectrum is NOT covering this story
function detectBlindspot(coverage, sourceIds) {
  const total = coverage.gauche + coverage.centre + coverage.droite;
  if (total < 2) return null; // need at least 2 sources to detect a blindspot

  const missing = [];
  if (coverage.gauche === 0) missing.push("gauche");
  if (coverage.centre === 0) missing.push("centre");
  if (coverage.droite === 0) missing.push("droite");

  if (missing.length === 0) return null;

  return {
    sides: missing,
    label: `Peu couvert par : ${missing.join(", ")}`,
  };
}

// Infer a category from article keywords (simple rule-based)
const CATEGORY_RULES = [
  { category: "Politique", keywords: ["gouvernement","ministre","parlement","sénat","assemblée","élection","macron","premier ministre","loi","vote"] },
  { category: "Économie", keywords: ["croissance","inflation","chômage","entreprise","marché","bourse","budget","pib","emploi","salaire"] },
  { category: "Social", keywords: ["grève","manifestation","syndicat","réforme","retraite","logement","santé","éducation","université"] },
  { category: "International", keywords: ["ukraine","gaza","israel","états-unis","chine","russie","ue","europe","sommet","diplomatie"] },
  { category: "Justice", keywords: ["tribunal","jugement","procès","condamné","mis en examen","garde à vue","prison","justice"] },
  { category: "Médias", keywords: ["médias","presse","télévision","radio","journaliste","cnews","bolloré","information"] },
  { category: "Technologie", keywords: ["intelligence artificielle","ia","numérique","tech","startup","silicon","données","cyber"] },
  { category: "Environnement", keywords: ["climat","réchauffement","co2","énergie","nucléaire","renouvelable","écologie","biodiversité"] },
];

function inferCategory(articles) {
  const text = articles
    .map((a) => `${a.title} ${a.summary}`)
    .join(" ")
    .toLowerCase();

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return rule.category;
    }
  }

  return "Actualité";
}

module.exports = { clusterArticles };
