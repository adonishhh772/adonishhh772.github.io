# On-site visitor counter

The portfolio can show **“You are visitor #N”** on the campus identity card, plus total unique visitors and how many times **Gather** was opened.

Counts are **persistent** (Cloudflare KV). **The same IP only counts once** as a unique visitor: the worker hashes the IP with a secret salt and never stores the raw address.

GitHub Pages only serves static files, so counting runs on a tiny **Cloudflare Worker** in `workers/visitor-stats/`. The site reads the worker URL from a **GitHub Actions variable** at build time.

## 1. Deploy the worker (one-time)

```bash
cd workers/visitor-stats
npm install
npx wrangler kv namespace create VISITOR_STATS
```

Copy the namespace `id` into `wrangler.toml` (replace `REPLACE_WITH_KV_NAMESPACE_ID`).

Set a random salt (keep it secret):

```bash
npx wrangler secret put IP_HASH_SALT
```

Adjust `ALLOWED_ORIGINS` in `wrangler.toml` if you use a custom domain.

```bash
npm run deploy
```

Note the worker URL, e.g. `https://abdbastola-visitor-stats.<account>.workers.dev`.

## 2. Wire the site (GitHub Pages)

Repository → **Settings** → **Secrets and variables** → **Actions** → **Variables**:

| Name | Example |
|------|---------|
| `PUBLIC_VISITOR_STATS_URL` | `https://abdbastola-visitor-stats.<account>.workers.dev` |

Redeploy the site (push to `main`). For local dev, add the same key to `.env`.

## 3. What visitors see

- **You are visitor #N** — their assigned number (stable for that IP).
- **Gather opened X times** — total outbound clicks to the live Gather app (simple mode / wider layout).

If `PUBLIC_VISITOR_STATS_URL` is unset, the counter is hidden and no requests are sent.

## API (for debugging)

- `GET /api/stats` — `{ totalUniqueVisitors, gatherClicks }`
- `POST /api/visit` — register visit (CORS + allowed origin)
- `POST /api/gather-click` — increment Gather clicks
