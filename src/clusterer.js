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

// Infer a category from article keywords and the RSS feed's own category tags.
// Scoring approach: each category scores keyword hits (with word boundaries so
// "loi" doesn't match "emploi"/"exploit"), plus a strong boost from the RSS
// feed's declared categories. Highest score wins.
const CATEGORY_RULES = [
  {
    category: "Sport",
    // Clubs, leagues, sports, major events. Distinct enough that any hit is a
    // strong signal — "coupe de france" alone is enough even if the text also
    // mentions a minister attending.
    keywords: [
      "football","foot","rugby","tennis","basket","handball","cyclisme","natation",
      "athlétisme","boxe","judo","formule 1","f1","moto gp","nba","jeux olympiques",
      "olympiques","ligue 1","ligue 2","premier league","liga","bundesliga","serie a",
      "champions league","ligue des champions","europa league","coupe de france",
      "coupe du monde","euro 2024","euro 2028","roland-garros","roland garros","wimbledon",
      "tour de france","six nations","top 14","xv de france","équipe de france",
      "psg","om","ol","lens","lille","losc","monaco","nice","bordeaux","rennes","nantes",
      "strasbourg","toulouse","montpellier","reims","rcs","asse","stade français",
      "mbappé","griezmann","zidane","deschamps",
      "match","buteur","finale","demi-finale","quart","penalty","arbitre","supporter",
    ],
    feedTags: ["sport","sports","football","rugby","tennis","basket","foot"],
  },
  {
    category: "Politique",
    // Removed the too-short "loi" and "vote" which collided with common French
    // words. Replaced with phrases and government-specific terms.
    keywords: [
      "gouvernement","premier ministre","ministre","ministère","parlement","sénat",
      "assemblée nationale","député","sénateur","élection","législatives",
      "présidentielle","présidentielles","municipales","européennes","macron",
      "matignon","élysée","rassemblement national","la france insoumise","renaissance",
      "les républicains","parti socialiste","écologistes","motion de censure",
      "projet de loi","loi de finances","49.3","conseil constitutionnel",
      "gauche","droite","extrême droite","extrême gauche",
    ],
    feedTags: ["politique","politics"],
  },
  {
    category: "Économie",
    keywords: [
      "croissance","inflation","chômage","entreprise","marché","bourse","budget",
      "pib","salaire","smic","licenciement","dette publique","déficit","impôt","tva",
      "banque","financière","investissement","startup",
    ],
    feedTags: ["économie","economie","economy","finance","bourse"],
  },
  {
    category: "Social",
    keywords: [
      "grève","manifestation","syndicat","réforme des retraites","logement","santé publique",
      "hôpital","éducation nationale","université","rectorat","inégalités","pauvreté",
      "pouvoir d'achat","chômeur","précarité","cgt","cfdt",
    ],
    feedTags: ["social","société","societe","society"],
  },
  {
    category: "International",
    keywords: [
      "ukraine","gaza","israël","israel","hamas","palestine","états-unis","usa","washington",
      "chine","pékin","russie","moscou","poutine","trump","biden","zelensky","netanyahu",
      "union européenne","bruxelles","otan","onu","sommet","diplomatie","ambassade",
    ],
    feedTags: ["international","monde","world"],
  },
  {
    category: "Justice",
    keywords: [
      "tribunal","jugement","procès","condamné","condamnation","mis en examen",
      "garde à vue","prison","perpétuité","cour d'assises","procureur","magistrat",
      "enquête judiciaire","parquet","cassation",
    ],
    feedTags: ["justice","faits divers","faits-divers"],
  },
  {
    category: "Faits divers",
    keywords: [
      "accident","drame","meurtre","homicide","tué","tuée","agression","vol","braquage",
      "incendie","noyade","disparu","corps retrouvé","victime","blessé grièvement",
    ],
    feedTags: ["faits divers","faits-divers"],
  },
  {
    category: "Médias",
    keywords: [
      "médias","presse","télévision","radio","journaliste","cnews","bolloré",
      "liberté de la presse","rsf","arcom",
    ],
    feedTags: ["médias","medias","media"],
  },
  {
    category: "Technologie",
    keywords: [
      "intelligence artificielle","chatgpt","openai","anthropic","claude","gemini",
      "numérique","startup french tech","licorne","silicon valley","cybersécurité",
      "cyberattaque","piratage","données personnelles","rgpd","metaverse",
    ],
    feedTags: ["tech","technology","technologie","numérique","numerique"],
  },
  {
    category: "Environnement",
    keywords: [
      "climat","réchauffement climatique","co2","transition énergétique","nucléaire",
      "énergies renouvelables","écologie","biodiversité","canicule","sécheresse",
      "inondation","pollution","cop28","cop29","giec","greenpeace",
    ],
    feedTags: ["environnement","environment","climat","ecologie","écologie"],
  },
  {
    category: "Culture",
    keywords: [
      "cinéma","film","réalisateur","réalisatrice","acteur","actrice","césar",
      "cannes","festival de cannes","mostra","venise","sortie en salle","box office",
      "musique","chanson","album","concert","tournée","artiste","exposition","musée",
      "louvre","pompidou","orsay","livre","roman","goncourt","renaudot","médicis",
      "théâtre","comédie française","opéra",
    ],
    feedTags: ["culture","cinéma","cinema","musique","music","livres","arts"],
  },
];

// Pre-compile regexes with Unicode + word-boundary behavior that works for
// French (accented letters are part of the word). We use lookarounds for
// boundary instead of \b because \b doesn't treat é/à as word characters.
const WORD_EDGE = `(?:^|[^\\p{L}\\p{N}])`;
const WORD_EDGE_END = `(?:$|[^\\p{L}\\p{N}])`;
function buildKeywordRegex(keywords) {
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`${WORD_EDGE}(?:${escaped.join("|")})${WORD_EDGE_END}`, "giu");
}
const COMPILED_RULES = CATEGORY_RULES.map(r => ({
  ...r,
  regex: buildKeywordRegex(r.keywords),
  feedTagSet: new Set(r.feedTags),
}));

function inferCategory(articles) {
  const text = articles
    .map((a) => `${a.title || ""} ${a.summary || ""}`)
    .join(" ")
    .toLowerCase();

  const feedTags = new Set();
  articles.forEach(a => (a.categories || []).forEach(c => feedTags.add(c.toLowerCase())));

  let best = { category: "Actualité", score: 0 };
  for (const rule of COMPILED_RULES) {
    const matches = text.match(rule.regex) || [];
    let score = matches.length;
    // RSS tag match is a strong signal — worth several keyword hits.
    for (const tag of feedTags) {
      for (const rt of rule.feedTagSet) {
        if (tag === rt || tag.includes(rt)) { score += 5; break; }
      }
    }
    if (score > best.score) best = { category: rule.category, score };
  }

  return best.category;
}

module.exports = { clusterArticles };
