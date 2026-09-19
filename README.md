# adonishhh772.github.io

Personal portfolio for **Abd Bastola** — Lead AI Engineer building reliable
enterprise AI systems in London. Publisher of the **Reliable AI** newsletter.

Live at **https://adonishhh772.github.io/**

Built with [Astro](https://astro.build) (static generation), plain CSS and
[three.js](https://threejs.org). No backend, no framework runtime, no paid
asset services. Deploys to GitHub Pages from GitHub Actions.

## The site is one place

The 3D world **is** the interface. On entry the viewport fills with a
miniature AI studio campus, and everything the site contains is read inside
it: the complete CV, every article, every case study, the repository list and
the contact options. Nothing ejects you into a separate conventional page.

```
                    ┌──────────────────────────────┐
                    │        the observatory       │  campus landmark
                    └──────────────────────────────┘
   studio ──┐                                        ┌── workshop
            │            lit ring walkways           │
   library ─┤                                        ├── contact
            └──────────── workbench ─────────────────┘
```

| Destination  | Where it is            | What you read there                         |
| ------------ | ---------------------- | ------------------------------------------- |
| **Campus**   | the observatory        | the overview; the identity caption          |
| **Studio**   | low building, warm lit | the full CV (print/save) and the biography  |
| **Workshop** | sawtooth canopy        | case studies, one installation per project  |
| **Library**  | barrel-vaulted hall    | every published issue, one book per article |
| **Workbench**| gantry and bench       | the curated repositories, one plaque each   |
| **Contact**  | gateway and beacon     | email, LinkedIn, booking and the newsletter |

Destinations are *places*; documents are read at them. One place can hold
several documents — the studio holds the CV and the biography, the workshop
holds every case study.

### There is no navigation bar — the world is the navigation

Nothing is open when you arrive. You get the campus and its captions, and
everything else follows from what you select.

- **A place caption moves you there.** *CV*, *Projects*, *Writing*, *Open
  source*, *Contact* and *Home* are buttons, not links: selecting one travels
  the camera and reveals that place's own objects. The URL does not change,
  because you have looked around — you have not opened anything.
- **An object caption opens its document.** Once you are at a place its
  objects appear: the CV and the biography at the studio, each project in the
  workshop, each article on the library shelves, each repository on the
  workbench. Those are real links with real URLs.
- **Every place also has an index caption** — *All writing*, *All projects*,
  *All repositories*, *Contact* — so the archive pages stay reachable from
  the world alone.
- **The camera is yours.** Drag to orbit, scroll or pinch to zoom,
  double-click to recentre. Both are available everywhere, not in a special
  mode, and are bounded so the island can never be lost.
- **URLs are still real.** A deep link (`/cv/`, `/writing/<slug>/`) opens the
  world at that place with that document already open; refresh works; Back
  and Forward work.
- **The renderer never restarts.** Astro's router swaps the page around a
  persisted canvas, so moving between destinations keeps one WebGL context,
  one scene and one camera. Only the reading surface is replaced.
- **The camera composes for what is visible.** The reading surface is a side
  panel on desktop and a bottom sheet on a phone; the camera frames the
  destination in the region the document leaves free, on both axes.
- **Reading settles the scenery.** Ambient motion stops while a document is
  open and starts again when it closes.
- **Tapping the world works too.** A tap that never became a drag resolves
  against the scene: a caption under the finger is activated, otherwise the
  object itself answers - a destination travels, the light switch throws.
- **The chrome is always there.** A compact bar holds the location readout,
  the **Map** (a labelled list of every place and document, as real links),
  **Home**, the **sun/moon light switch** and **pause motion**. It takes the
  edge opposite the reading surface on a desktop and the top strip on a phone,
  so it stays reachable from the CV, an article, a case study or the contact
  card. No destination can be lost behind a building or a panel.
- **The camera is bounded and unambiguous.** A press only becomes a drag once
  it has travelled far enough to be unarguable, and a press that starts on a
  control belongs to that control - never to the camera.
- **Closing puts you back.** *Close* (and `Escape`) returns to the view the
  document was opened from, orbit and zoom included; the bar's other control
  goes to that place's list. Focus follows the document in and back out again.

### Day and night

The light is one authoritative state, held as `data-theme` on `<html>` and
remembered in `localStorage` once the visitor makes an explicit choice. Until
then the system preference is honoured.

- **Both controls, one state.** A physical lever on the campus plateau throws
  as the light changes, and a compact sun/moon switch in the chrome is visible
  whatever is open. Either drives the same value, as do the keyboard and the
  caption anchored to the post.
- **It changes the scene, not a filter.** Sky gradient, fog colour and
  density, hemisphere and key lights, practical lamps, lamp and window
  emissives, the environment probe, exposure and the shadow tuning all take
  part in one coordinated ~700ms blend. There is no dark overlay over the
  canvas.
- **The page changes with it.** Reading panels, forms, captions and the chrome
  cross-fade over the same period. Under `prefers-reduced-motion` the state
  applies immediately.
- **Nothing else moves.** Changing the light preserves the camera, the
  destination, the open document, the reading position and any form input.

### Architecture

```
src/lib/world/
├── destinations.ts    the campus map, shared by server and client
├── state.ts           the page/shell contract: destination, surface, index,
│                      and the view to return to
├── document-state.ts  the pre-paint capability and theme decisions, carried
│                      across Astro's route swaps
├── theme-state.ts     the one day/night state, its storage and its events
├── chrome.ts          the persistent controls (map, Home, light, pause)
├── page-controls.ts   idempotent delegated page behaviour: forms, filters,
│                      contents rails, print, counters, scroll reveal
└── shell.ts           renderer lifecycle, camera composition, captions,
                       tap-versus-drag, quality, navigation, teardown

src/lib/observatory/  the world itself
├── theme.ts          palette bridge - reads the --world-* tokens from CSS and
│                      blends two themes for the transition
├── quality.ts        tiers, device detection, frame-time monitor
├── materials.ts      one material library, recoloured in place
├── parts.ts          procedural geometry (island, dome, lattice, books, drone)
├── lighting.ts       sky dome, key/fill/practical lights, PMREM environment
├── world.ts          the campus: six destinations, walkways, objects, the
│                      light switch, animation
└── camera.ts         shot-to-shot travel, bounded orbit, restorable state

src/components/world/
├── WorldShell.astro  the persisted canvas + captions + status
├── WorldChrome.astro the persisted controls + the branded failure screen
└── Identity.astro    the campus heading: a corner caption in the world,
                      the opening of the page in the fallback
```

**The page declares where it is.** Each page sets four attributes on `<body>`:

```html
<body data-destination="library" data-surface="article"
      data-surface-id="from-demo-to-dependable" data-panel="left">
```

The shell reads those on boot and again after every client-side navigation, so
the URL, the DOM and the world can never disagree.

**The world is built from the content, not a list.** `BaseLayout` embeds the
real collections as JSON (`data-world-index`), so the library lays out one book
per published article, the workbench one plaque per curated repository and the
workshop one installation per project. Add a Markdown file and a new object
appears.

### When the world cannot run

There is no mode to switch into and no silent fallback to a conventional
portfolio. If the world cannot start, it says so.

- A **pre-paint probe** decides `data-mode`: `world` when JavaScript and WebGL
  are both available. With no JavaScript at all the attribute is simply
  absent, and the default CSS renders the same semantic documents as ordinary
  readable pages — which is also what search engines and browserless visitors
  get.
- **three.js is a dynamic import gated on that decision**, so a visitor whose
  browser cannot render the world never downloads the 3D bundle.
- **A failure is reported honestly.** A browser with no WebGL, a renderer that
  throws, a module that fails to download and a watchdog for a startup that
  never finishes all raise the same branded screen: what happened, **Try
  again**, **Reload the page**, and the world's own routes (which open inside
  the world once it recovers).
- **Retry rebuilds exactly one renderer**, disposing the failed attempt and
  its canvas first. Nothing is retried automatically for an unsupported
  capability.
- **Losing the WebGL context** is announced and then recovered in place:
  three.js re-initialises its GL state on the restored context, so the same
  scene and camera come back rather than a second renderer being built.

### Quality

| Tier     | DPR cap | Shadows  | Vegetation | Mist | Signals | Detail |
| -------- | ------- | -------- | ---------- | ---- | ------- | ------ |
| Full     | 2.0     | 2048 PCF | 3 rings    | 5    | 5       | yes    |
| Balanced | 1.75    | 1024 PCF | 2 rings    | 3    | 3       | yes    |
| Lite     | 1.25    | off      | 1 ring     | 2    | 2       | no     |

The starting tier is chosen conservatively from `deviceMemory`,
`hardwareConcurrency`, pointer type, DPR, connection type and reduced-motion
preference. A rolling 90-frame median then downgrades on sustained slowness and
may upgrade once if the device comfortably holds 60 fps. The preference is
stored in `localStorage` (`observatory:quality`). Rendering pauses when the tab
is hidden or the stage leaves the viewport, ambient animation settles while a
document is open, and the chrome's **pause motion** control (or
`prefers-reduced-motion`) does the same on demand.

## Design system

Palette, defined once in `:root` of `src/styles/global.css`:

| Token      | Night     | Day       | Notes                               |
| ---------- | --------- | --------- | ----------------------------------- |
| `--bg`     | `#0B1020` | `#F3F0E8` | Midnight ink / warm ivory           |
| `--accent` | `#6EE7D8` | `#0B6D66` | Teal; darkened in day for text use  |
| `--signal` | `#F4B860` | `#8A4F0D` | Warm amber for lamps and highlights |
| `--text`   | `#F3F0E8` | `#0F1421` | 16.6:1 / 16.1:1 on the background   |
| `--muted`  | `#A7AEBE` | `#4C5566` | 8.5:1 / 6.6:1 on the background     |
| `--faint`  | `#7E8798` | `#61697B` | 5.2:1 / 4.8:1 on the background     |

The 3D world reads the same tokens through `--world-*`, so the canvas and the
page can never drift apart — switching theme recolours both.

Type: **Fraunces Variable** for display, **Inter Variable** for body,
**JetBrains Mono Variable** for labels. Self-hosted via Fontsource; the two
faces used above the fold are preloaded, which removed the font-swap layout
shift entirely.

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

### Copy, links and the campus map

`src/site.config.ts` holds the name, role, meta description, the copy used by
the shell and simple mode, navigation, social links, contact details, booking
and newsletter configuration.

`src/lib/world/destinations.ts` holds the campus map: each destination's
caption label, longer name, which side its reading surface takes, and the
index caption that leads to its archive page. Moving a destination to the
other side of the screen is a one-word change there.

### Adding a newsletter article

Create `src/content/writing/my-new-article.md` with `title`, `description`,
`pubDate`, optional `updatedDate`, `issue`, `tags` and `draft`. It then gets its
own route, appears in the archive and the RSS feed, **and a new book appears on
the library shelf** — nothing in the scene is hard-coded.

Set `draft: true` to hide it everywhere.

### Adding a case study

Same pattern in `src/content/projects/`. A new installation is added to the
workshop automatically. Each case study renders a `ProjectDiagram` — a
hand-drawn inline SVG architecture sketch; add an entry to `diagramCaptions` in
`src/pages/work/[slug].astro` when you add a project.

### Adding a repository

Append to `src/data/github-projects.ts`; a plaque is added to the workbench and
the full list appears on `/open-source/`.

### Newsletter form (environment variable)

```
NEWSLETTER_FORM_URL=https://your-provider-form-endpoint
```

Copy `.env.example` to `.env` locally; in CI set a repository **Actions
variable** with the same name. While it is empty the site renders an honest
"launching soon" note instead of a broken form.

**Auto-sending new posts:** `.github/workflows/newsletter-send.yml` emails each
new article to the Buttondown list using the `BUTTONDOWN_API_KEY` secret.

### Contact form and scheduling

- **`CONTACT_ACCESS_KEY`** — free [Web3Forms](https://web3forms.com) key for the
  contact form. When unset, the contact station offers email instead.
- **`BOOKING_URL`** — a scheduling link (Cal.com, Calendly). When unset, the
  site offers to arrange a call by email.

## Accessibility

- Semantic documents: the CV, articles and case studies are ordinary HTML in
  the page, not text painted onto the canvas.
- Skip link, one `h1` per page, visible focus rings, and the chrome is a
  labelled set of real controls — the map is a navigation of real links.
- Every caption is a real control: place captions are buttons that travel the
  camera, object captions are links, the light switch is a button announced as
  a switch with its current state. All are reachable by Tab and activated by
  Enter.
- Captions that the reading surface covers, or that a building hides, are
  removed from the tab order rather than left focusable but invisible. A
  caption that survives a rebuild keeps focus, so travelling never drops the
  keyboard.
- Opening a document moves focus onto its heading; closing returns focus to
  the caption it was opened from, or to the map control.
- `prefers-reduced-motion` removes camera travel and ambient animation and
  applies the day/night change instantly; the chrome's **pause motion**
  control does the same on demand.
- Text contrast meets WCAG AA in both themes (ratios above).
- Touch targets are at least 44x44 CSS pixels, safe areas are respected, and
  the reading sheet keeps its close, Home/Map and light switch reachable.
- Every destination is reachable with no JavaScript, with no WebGL, and from
  the map menu alone.

## Verifying the world

`tools/worldcheck/` drives a real headless browser over the DevTools Protocol —
no test dependencies, just Node's own `fetch` and `WebSocket`. Run the preview
server first, then:

```bash
npm run build
npm run preview                                  # http://localhost:4321
npm run verify:world   -- http://localhost:4321  # the full journey suite
npm run verify:a11y    -- http://localhost:4321  # focus, print, scrolling
npm run verify:content -- http://localhost:4321  # a new Markdown file appears
```

Screenshots land in `.screenshots/world/`. The suite checks navigation by
caption, tap-versus-drag, theme persistence across routes, document open and
close with camera and focus restoration, the physical switch, filters, forms,
deep links, Back/Forward, context loss and recovery, and five viewport widths.

## Deployment (GitHub Pages)

This repository (`adonishhh772/adonishhh772.github.io`) is a user site, served
from the domain root.

`astro.config.mjs` resolves `site`/`base` from the `GITHUB_REPOSITORY`
environment variable that Actions injects, so builds are correct for user-site
(root) or project-site (`/<repo>/`) hosting.

1. Push to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. `.github/workflows/deploy.yml` runs on every push to `main` and on manual
   dispatch.

Because the world uses client-side routing, GitHub Pages only has to serve the
static files; the custom 404 still covers genuinely unknown paths.

## Third-party assets

| Asset                                       | Licence     | Use                 |
| ------------------------------------------- | ----------- | ------------------- |
| three.js                                    | MIT         | the campus renderer |
| Fontsource: Fraunces, Inter, JetBrains Mono | SIL OFL 1.1 | self-hosted webfonts |

No textures, models, audio or paid assets are downloaded at runtime. All
geometry, the sky gradient, the mist falloff, the environment probe and the
poster illustration are generated locally.

## Licence

MIT — see [LICENSE](LICENSE).
