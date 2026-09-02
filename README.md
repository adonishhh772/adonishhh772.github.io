# abdbastola.github.io

Personal portfolio and writing hub for **Abd Bastola** — AI Engineer building
reliable enterprise AI systems in London. Publisher of the **Reliable AI**
newsletter.

Built with [Astro](https://astro.build) (static site generation), plain CSS,
and zero backend. Deploys to GitHub Pages from GitHub Actions.

## What's on the site

| Route                  | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `/`                    | Home — hero, newsletter sign-up, selected work, latest writing |
| `/work`                | Selected work index                                         |
| `/work/[slug]`         | Individual anonymised case studies (`kai`, `aruva`, `hyperran`) |
| `/writing`             | Reliable AI newsletter landing page + article archive       |
| `/writing/[slug]`      | Individual newsletter articles                              |
| `/about`               | Professional biography                                      |
| `/cv`                  | Web CV                                                      |
| `/rss.xml`             | RSS feed for the newsletter                                 |
| `/404`                 | Custom 404 page                                             |

## Project structure

```
.
├── .github/workflows/deploy.yml   # GitHub Pages deployment
├── astro.config.mjs               # Astro config (site URL, sitemap)
├── public/                        # favicon, robots.txt
└── src/
    ├── site.config.ts             # ★ single config file for copy + links
    ├── content.config.ts          # content collection schemas
    ├── content/
    │   ├── writing/               # ★ newsletter articles (Markdown)
    │   └── projects/              # ★ case studies (Markdown)
    ├── components/                # nav, footer, cards, sign-up, coffee card
    ├── layouts/                   # BaseLayout
    ├── lib/                       # date/reading-time helpers
    ├── pages/                     # routes (home, work, writing, about, cv, 404, rss)
    └── styles/global.css          # design tokens + all site CSS
```

## Local development

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # production build → dist/
npm run preview    # preview the production build locally
```

`npm run check` runs the Astro/TypeScript language check.

## Editing content

### Social links, coffee link, navigation (one file)

Everything user-facing that you will want to change lives in
**`src/site.config.ts`**:

- **GitHub / LinkedIn URLs** — `nav.external`, plus `social.github` /
  `social.linkedin` (placeholders marked `TODO`).
- **Buy Me a Coffee URL** — `coffee.url`
  (change `<BUY_ME_A_COFFEE_USERNAME>` to your username).
- **Contact email** — `contact.email`.
- Newsletter copy, hero copy, location, meta description — same file.

### Newsletter form URL (environment variable)

The sign-up form posts to a single environment/config value:

```
NEWSLETTER_FORM_URL=https://your-provider-form-endpoint
```

Copy `.env.example` to `.env` and fill it in for local builds. In CI, set a
repository **Actions variable** named `NEWSLETTER_FORM_URL` (Settings →
Secrets and variables → Actions → Variables) — the workflow already reads it.

While the variable is empty the site renders a graceful placeholder
(“Daily issues are launching soon…”) instead of a broken form, so you can
ship before connecting an email provider.

### Adding a newsletter article

1. Create a new file in `src/content/writing/`, e.g.
   `src/content/writing/my-new-article.md`. The file name becomes the URL
   slug (`/writing/my-new-article`).
2. Copy the frontmatter shape from an existing article:

   ```md
   ---
   title: 'Your title'
   description: 'One or two sentences used on cards, meta and RSS.'
   pubDate: 2026-09-15
   issue: 4
   tags: [agents, evaluation]
   draft: false
   ---
   ```

3. Write the body in Markdown. End with a short `## The takeaway` list if
   you want the closing block to match the other issues.
4. The article automatically appears on `/writing`, the home page “Latest
   writing” (if within the newest three), the RSS feed and its own route.

To draft without publishing, set `draft: true` — the article is then hidden
from all indexes, the RSS feed and its page.

### Adding or editing case studies

Same pattern in `src/content/projects/`. Each study should cover the
problem, your role, the approach, architecture/themes, outcomes (kept
qualitative and clearly separated from implementation detail) and what you
learned. Cards on `/` and `/work` are generated from the frontmatter.

To change the order of the three home-page cards, edit the `projectOrder`
array at the top of `src/pages/index.astro` (and `src/pages/work.astro`).

### CV placeholders

`src/pages/cv.astro` contains clearly marked `[placeholder]` fields for
earlier experience and education — replace them with your real detail and
delete the surrounding `TODO` comments.

## Deployment (GitHub Pages)

The Astro config resolves `site` and `base` automatically from the
`GITHUB_REPOSITORY` environment variable that GitHub Actions provides:

- Repo `<owner>/<owner>.github.io` → **user site** at the domain root
  (`base: "/"`, e.g. `https://abdbastola.github.io` — requires the repo
  owner to *be* `abdbastola`).
- Any other repo → **project site** under `/<repo>/` on the owner's pages
  domain (e.g. `https://adonishhh772.github.io/abdbastola.github.io/`).

Local development (no `GITHUB_REPOSITORY`) defaults to the user-site
identity from this spec.

To deploy:

1. Push the repository to GitHub.
2. In **Settings → Pages**, set “Build and deployment” → **Source** to
   **GitHub Actions** (not “Deploy from a branch” — branch deployment
   runs Jekyll over the Astro sources and fails).
3. The `Deploy to GitHub Pages` workflow (`.github/workflows/deploy.yml`)
   runs on every push to `main` and on manual dispatch.

If the site must live at `https://abdbastola.github.io`, the repository
must be owned by the `abdbastola` account — either create/transfer the
repo there or rename the owning account to match.

## Design notes

- Palette: near-black `#0B0D10`, soft-white `#F4F4F0`, muted `#A4ABB5`,
  electric-lime accent `#C8FF00`.
- Fonts: Inter (variable) for text, JetBrains Mono (variable) for labels,
  bundled locally via Fontsource — no runtime font CDN.
- Subtle grid + noise texture, restrained hover states, semantic HTML,
  skip-to-content link, per-page meta/OG tags, RSS, sitemap, custom 404,
  mobile-first responsive layout, `prefers-reduced-motion` support.

## License

MIT — see [LICENSE](LICENSE).
