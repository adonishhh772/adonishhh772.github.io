# adonishhh772.github.io

Personal portfolio and writing hub for **Abd Bastola** — Lead AI Engineer
building reliable enterprise AI systems in London. Publisher of the **Reliable
AI** newsletter.

Live at **https://adonishhh772.github.io/**

Built with [Astro](https://astro.build) (static generation), plain CSS and
[three.js](https://threejs.org). No backend, no framework runtime, no paid
asset services. Deploys to GitHub Pages from GitHub Actions.

## What's on the site

| Route           | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `/`             | Home — the AI Observatory, by-the-numbers, work, writing, contact   |
| `/work`         | Selected work index with diagrams and filters                       |
| `/work/[slug]`  | Case studies (`kai`, `education-platform`, `hyperran`) with contents |
| `/writing`      | Reliable AI newsletter landing page, featured issue and archive     |
| `/writing/[slug]` | Individual articles, with a contents rail on long pieces          |
| `/about`        | Professional biography, portrait, focus areas                       |
| `/cv`           | Web CV with sticky contents, print/PDF output                       |
| `/contact`      | Email, LinkedIn, contact form and optional booking                  |
| `/rss.xml`      | RSS feed for the newsletter                                         |
| `/robots.txt`   | Crawler policy with a deployment-aware sitemap URL                   |
| `/404`          | Custom 404 page                                                     |

## The AI Observatory

The home page hero is a miniature, art-directed world: a floating island with a
central observatory (a ribbed dome over a colonnade, carrying a slowly turning
orbital mechanism), a work pavilion with three exhibit vitrines, a knowledge-graph
garden, a signal tower, a personal studio and a contact beacon — joined by lit
walkways, patrolled by a small guide drone, and hiding three light markers that
switch the observatory's lanterns on.

Everything is generated procedurally at runtime. There are no external models or
textures to download.

### Behaviour

- **Default browsing** is ordinary page scrolling. The world has ambient motion;
  scrolling never moves the camera. A short in-scene affordance ("Select a
  station, or explore the world") appears once the camera settles and retires on
  first interaction or after a few seconds, and a quiet scroll cue marks that the
  page continues below the first screen.
- **Explore the world** (or selecting any station) enters a bounded exploration
  mode: labelled stations travel the camera to a composed viewpoint (700–1100 ms,
  interruptible), with **Reset view** and **Exit exploration** always available.
  Desktop may drag to orbit within tight limits; touch devices never orbit and
  page scrolling is never captured.
- **Hotspots** are real DOM buttons projected from the world each frame, with
  occlusion culling, overlap culling and a per-viewport label budget. Occluded
  labels leave the tab order; the station menu still reaches every destination.
- **Preview panels** are dialogs with focus management, Escape to close and focus
  restoration. On phones they become a bottom sheet with internal scrolling.
- **Simple view** keeps every content destination reachable with no WebGL,
  no JavaScript and no canvas.
- **Reduced motion** removes camera travel and all ambient animation.

### Source layout

```
src/lib/observatory/
├── theme.ts        palette bridge — reads the --world-* tokens from CSS
├── quality.ts      tiers, device detection, frame-time monitor
├── materials.ts    one material library, recoloured in place
├── parts.ts        procedural geometry (island, dome, lattice, graph, drone)
├── lighting.ts     sky dome, key/fill/practical lights, PMREM environment
├── world.ts        the world: stations, pathways, drone, discoveries, animation
├── camera.ts       shot-to-shot travel, bounded orbit
└── controller.ts   scene lifecycle, loop, quality, theme, interaction, hotspot
                    projection, panels, teardown

src/components/observatory/
├── Observatory.astro     hero stage markup + the deferred bootstrap
├── StationPoster.astro   inline-SVG poster (first paint and WebGL fallback)
├── ProjectDiagram.astro  one architecture sketch per case study
└── (icons live in src/components/Icon.astro)
```

Only `index.astro` imports `Observatory.astro`, so three.js is never fetched or
executed on interior pages.

### Quality management

| Tier     | DPR cap | Shadows       | Vegetation | Mist | Signals | Detail |
| -------- | ------- | ------------- | ---------- | ---- | ------- | ------ |
| Full     | 2.0     | 2048 PCF      | 3 rings    | 5    | 5       | yes    |
| Balanced | 1.75    | 1024 PCF      | 2 rings    | 3    | 3       | yes    |
| Lite     | 1.25    | off           | 1 ring     | 2    | 2       | no     |

The initial tier is chosen conservatively from `deviceMemory`,
`hardwareConcurrency`, pointer type, DPR, connection type and reduced-motion
preference. A rolling 90-frame median then downgrades on sustained slowness and
may upgrade once if the device comfortably holds 60 fps. The choice is stored in
`localStorage` (`observatory:quality`); the visible **Quality** control switches
between Auto, Full, Balanced and Lite.

Rendering pauses when the tab is hidden or the stage scrolls out of view.

## Design system

Palette (defined once in `:root` of `src/styles/global.css`):

| Token            | Night     | Day       | Notes                                 |
| ---------------- | --------- | --------- | ------------------------------------- |
| `--bg`           | `#0B1020` | `#F3F0E8` | Midnight ink / warm ivory             |
| `--accent`       | `#6EE7D8` | `#0B6D66` | Teal; darkened in day for text use    |
| `--signal`       | `#F4B860` | `#8A4F0D` | Warm amber for lamps and highlights   |
| `--text`         | `#F3F0E8` | `#0F1421` | 16.6:1 / 16.1:1 on the background     |
| `--muted`        | `#A7AEBE` | `#4C5566` | 8.5:1 / 6.6:1 on the background       |
| `--faint`        | `#7E8798` | `#61697B` | 5.2:1 / 4.8:1 on the background       |

All foreground/background pairs above meet WCAG AA; measured ratios are in the
commit notes. The 3D world reads the same tokens through `--world-*`, so the
canvas and the page can never drift apart — switching theme recolours both.

Type: **Fraunces Variable** for display (one variable file), **Inter Variable**
for body, **JetBrains Mono Variable** for labels and technical metadata. All
served locally via Fontsource; the two faces used above the fold are preloaded,
which removed the font-swap layout shift entirely.

## Performance

Measured on the production build (`npm run build`), Chrome 153, headless,
1440×1000, served locally (`npm run preview`):

| Metric                                          | Measured                        |
| ----------------------------------------------- | ------------------------------- |
| Initial non-3D JavaScript                        | **1.2 KB gzip** (one chunk)     |
| 3D payload (three.js + world + controller)       | **159.9 KB gzip** / 612.2 KB raw |
| CSS                                              | 15.4 KB gzip (13.3 KB brotli)   |
| Fonts actually fetched (Latin subsets)           | 122.3 KB woff2                  |
| Scene complexity                                 | 40,628 triangles, 135 draw calls |
| Poster / first paint                             | inline SVG, no extra request    |

Field-style measurements taken with `PerformanceObserver` in the same harness:

| Page                        | LCP     | CLS    |
| --------------------------- | ------- | ------ |
| `/` 1920×1200               | 848 ms  | 0.0000 |
| `/writing` 1920×1200        | 580 ms  | 0.0000 |
| `/work/kai` 1920×1200       | 204 ms  | 0.0000 |
| `/work/kai` 390×844         | 84 ms   | 0.0000 |
| `/cv` 390×844               | 96 ms   | 0.0000 |
| `/contact` 768×1024         | 84 ms   | 0.0000 |

Because the JavaScript is a `requestIdleCallback` dynamic import fired after
`load`, the numbers above describe a single-run local harness rather than a
throttled Lighthouse profile: they are honest but optimistic on network. The
architectural claim they support is directional, not a field measurement.

## Local development

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # production build → dist/
npm run preview    # preview the production build locally
npm run check      # Astro + TypeScript diagnostics
```

> If the default npm cache is not writable, pass a local one:
> `npm ci --cache .npm-cache`.

## Editing content

### Copy, links and the world's stations — one file

`src/site.config.ts` holds the site name, role, meta description, hero copy,
navigation, social links, contact details, booking and newsletter
configuration, **and** the observatory's station map (`stations`). Each station
declares a plain `label` ("Work", "Writing"), an in-world `alias`, a `blurb`, a
`body`, key facts and real `links` — so the world can never point at a route
that does not exist. `exhibits` on the `work` station is resolved against the
projects collection at build time.

### Newsletter form (environment variable)

```
NEWSLETTER_FORM_URL=https://your-provider-form-endpoint
```

Copy `.env.example` to `.env` locally; in CI set a repository **Actions
variable** with the same name (Settings → Secrets and variables → Actions →
Variables). While the variable is empty the site renders a graceful
"launching soon" note instead of a broken form.

**Auto-sending new posts:** `.github/workflows/newsletter-send.yml` emails each
newly added article to the Buttondown list using the `BUTTONDOWN_API_KEY`
secret.

### Contact form and scheduling

- **`CONTACT_ACCESS_KEY`** — free [Web3Forms](https://web3forms.com) key for the
  `/contact` form. When unset, `/contact` offers a mailto button instead.
- **`BOOKING_URL`** — a scheduling link (Cal.com, Calendly). When unset, the
  site offers to arrange a call by email.

### Adding a newsletter article

1. Create `src/content/writing/my-new-article.md`; the file name becomes the
   slug.
2. Frontmatter: `title`, `description`, `pubDate`, optional `updatedDate`,
   `issue`, `tags`, `draft`.
3. Write Markdown. Articles with four or more `##` sections automatically get a
   contents rail and scroll-spy.
4. Set `draft: true` to hide an article from every index, the RSS feed and its
   own route.

### Adding or editing case studies

Same pattern in `src/content/projects/`. Each study should cover the problem,
your role, the approach, architecture/themes, outcomes (qualitative and clearly
separated from implementation detail) and what was learned. `##` headings become
the on-page contents. The home-page order is the `projectOrder` array in
`src/pages/index.astro` and `src/pages/work.astro`.

Each case study also renders a `ProjectDiagram` — a hand-drawn inline SVG
architecture sketch. Add an entry to `diagramCaptions` when you add a project.

### Portrait photo

`public/images/abd-bastola.jpg` (About, CV) and
`public/images/abd-bastola-avatar.jpg` (header).

## Accessibility

- Semantic landmarks, one `h1` per page, skip link, visible focus rings.
- Every destination is reachable without the 3D scene: the station menu is a
  native `<details>`, the simple view lists all six stations, and every preview
  panel carries real links.
- Occluded hotspot labels are removed from the tab order rather than left
  focusable but invisible.
- Panels are dialogs with Escape-to-close and focus restoration to a visible
  control.
- `prefers-reduced-motion` removes camera travel and ambient animation; a
  visible **Pause motion** control does the same on demand.
- Text contrast meets WCAG AA in both themes (ratios in the table above).

## Deployment (GitHub Pages)

This repository (`adonishhh772/adonishhh772.github.io`) is a user site, so the
build is served from the domain root: **https://adonishhh772.github.io/**.

`astro.config.mjs` resolves `site`/`base` from the `GITHUB_REPOSITORY`
environment variable that Actions injects, so builds are correct for user-site
(root) or project-site (`/<repo>/`) hosting. Local development defaults to the
user-site identity.

1. Push to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. `.github/workflows/deploy.yml` runs on every push to `main` and on manual
   dispatch.

## Third-party assets

| Asset                              | Licence            | How it is used                    |
| ---------------------------------- | ------------------ | --------------------------------- |
| three.js                           | MIT                | the observatory renderer          |
| Fontsource: Fraunces, Inter, JetBrains Mono | SIL OFL 1.1 | self-hosted webfonts              |

No textures, models, audio or paid assets are downloaded at runtime. All
geometry, the sky gradient, the mist falloff, the environment probe and the
poster illustration are generated locally (canvas or inline SVG).

## Licence

MIT — see [LICENSE](LICENSE).
