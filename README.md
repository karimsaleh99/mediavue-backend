# MédiaVue Backend

RSS aggregation pipeline for MédiaVue — fetches, clusters, and serves French news stories.

## How it works

```
RSS Feeds → Fetcher → Clusterer (TF-IDF) → Bias Tagger → Supabase DB → REST API
```

Every 15 minutes, the pipeline:
1. Polls 6 French RSS feeds in parallel
2. Groups articles about the same event using cosine similarity on French titles
3. Tags each story with bias distribution and blindspot detection
4. Saves to Supabase and serves via the API

---

## Local setup (5 minutes)

### 1. Install dependencies
```bash
npm install
```

### 2. Set up Supabase (free)
1. Go to [supabase.com](https://supabase.com) → New project
2. Once created: **SQL Editor → New query** → paste `supabase-schema.sql` → Run
3. Go to **Settings → API** → copy your Project URL and `service_role` secret key

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your Supabase URL and service key
```

### 4. Run
```bash
npm run dev     # development (auto-restarts on file changes)
npm start       # production
```

The server starts on `http://localhost:3001`. On startup it immediately runs the pipeline and logs results.

---

## API Reference

### `GET /api/stories`
Main feed — stories sorted by coverage count then date.

**Query params:**
| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 20 | Max stories to return (max 50) |
| `offset` | number | 0 | Pagination offset |
| `category` | string | — | Filter by category (Politique, Économie, etc.) |

**Response:**
```json
{
  "stories": [
    {
      "id": "uuid",
      "title": "Réforme des retraites : nouvelles manifestations",
      "summary": "Des milliers de manifestants...",
      "category": "Social",
      "published_at": "2026-03-31T08:00:00Z",
      "coverage_count": 5,
      "source_ids": ["lemonde", "lefigaro", "liberation", "bfmtv", "mediapart"],
      "coverage_by_orientation": { "gauche": 3, "centre": 1, "droite": 1 },
      "blindspot": null
    }
  ],
  "meta": { "limit": 20, "offset": 0, "count": 15 }
}
```

### `GET /api/stories/:id`
Single story with all linked articles.

### `GET /api/sources`
All 6 sources with orientation, factuality, and ownership data.

### `GET /api/status`
Pipeline health — last run time, article/story counts, errors.

### `POST /api/pipeline/run`
Manually trigger a pipeline run. Useful during development.

---

## Deploy to Railway (free)

Railway gives you a free server with persistent runs — perfect for the cron job.

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Add environment variables: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
5. Railway auto-detects Node.js and runs `npm start`
6. Done — your API is live at `https://your-app.railway.app`

---

## Tuning the clusterer

The similarity threshold in `src/clusterer.js` controls how aggressively articles are grouped:

```js
const SIMILARITY_THRESHOLD = 0.20; // lower = more stories grouped together
```

- **Too low (< 0.15)**: Unrelated articles get merged into the same story
- **Too high (> 0.35)**: The same story appears as multiple separate cards
- **Sweet spot**: 0.18–0.25 for French news titles

Monitor the ratio of articles to stories in `/api/status`. A healthy ratio is roughly 3–6 articles per story.

---

## Adding more sources

Edit `src/sources.js` — add a new object to the `SOURCES` array:

```js
{
  id: "cnews",
  name: "CNews",
  url: "https://www.cnews.fr/rss.xml",
  orientation: "droite extrême",
  orientationScore: 5,
  factuality: "mixte",
  owner: "Vincent Bolloré (Vivendi)",
  ownerType: "milliardaire conservateur",
  logo: "CN",
  color: "#2c3e50",
  founded: 1999,
}
```

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 22 |
| HTTP server | Express |
| RSS parsing | `rss-parser` |
| NLP / clustering | `natural` (TF-IDF + cosine similarity) |
| Scheduler | `node-cron` |
| Database | Supabase (PostgreSQL) |
| Deployment | Railway |
