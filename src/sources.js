// src/sources.js
// All configured French news sources with their RSS feeds and bias metadata

const SOURCES = [
  {
    id: "lemonde",
    name: "Le Monde",
    url: "https://www.lemonde.fr/rss/une.xml",
    orientation: "centre-gauche",
    orientationScore: 2,       // 0=far left, 3=centre, 5=far right
    factuality: "haute",
    owner: "Xavier Niel / Matthieu Pigasse",
    ownerType: "milliardaires indépendants",
    logo: "LM",
    color: "#1a1a2e",
    founded: 1944,
  },
  {
    id: "lefigaro",
    name: "Le Figaro",
    url: "https://www.lefigaro.fr/rss/figaro_actualites.xml",
    orientation: "droite",
    orientationScore: 4,
    factuality: "haute",
    owner: "Famille Dassault (SOCPRESSE)",
    ownerType: "groupe industriel",
    logo: "LF",
    color: "#8b1a1a",
    founded: 1826,
  },
  {
    id: "liberation",
    name: "Libération",
    url: "https://www.liberation.fr/arc/outboundfeeds/rss/?outputType=xml",
    orientation: "gauche",
    orientationScore: 1,
    factuality: "haute",
    owner: "Altice / Patrick Drahi",
    ownerType: "milliardaire télécom",
    logo: "LIB",
    color: "#c0392b",
    founded: 1973,
  },
  {
    id: "mediapart",
    name: "Médiapart",
    url: "https://www.mediapart.fr/articles/feed",
    orientation: "gauche",
    orientationScore: 0,
    factuality: "haute",
    owner: "Indépendant (société de lecteurs)",
    ownerType: "indépendant",
    logo: "MP",
    color: "#e74c3c",
    founded: 2008,
  },
  {
    id: "bfmtv",
    name: "BFMTV",
    url: "https://www.bfmtv.com/rss/news-24-7/",
    orientation: "centre",
    orientationScore: 3,
    factuality: "haute",
    owner: "Altice / Patrick Drahi",
    ownerType: "milliardaire télécom",
    logo: "BFM",
    color: "#2980b9",
    founded: 2005,
  },
  {
    id: "lesechos",
    name: "Les Échos",
    url: "https://www.lesechos.fr/rss/rss_une.xml",
    orientation: "centre-droite",
    orientationScore: 4,
    factuality: "haute",
    owner: "Bernard Arnault (LVMH)",
    ownerType: "milliardaire luxe",
    logo: "LE",
    color: "#16a085",
    founded: 1908,
  },
];

// Helper: get source by ID
const getSource = (id) => SOURCES.find((s) => s.id === id) || null;

// Helper: get orientation bucket (gauche / centre / droite)
const getOrientationBucket = (score) => {
  if (score <= 1) return "gauche";
  if (score <= 3) return "centre";
  return "droite";
};

module.exports = { SOURCES, getSource, getOrientationBucket };
