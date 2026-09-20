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
  workshop, each article and the **subscribe** handbill on the library shelves,
  each repository on the workbench, and the **message hatch** at the contact
  station. Those are real links with real URLs — and the repositories, being
  off-site, open in a new tab while everything of the portfolio's own stays in
  the world.
- **Every caption carries an icon**, so the caption layer reads as a map key
  rather than a row of blank circles.
- **Every place also has an index caption** — *All writing*, *All projects*,
  *All repositories*, *Contact* — so the archive pages stay reachable from
  the world alone.
- **The camera is yours.** Drag to orbit, scroll or pinch to zoom,
  double-click or press **Reset view** to recentre. Both are available
  everywhere, not in a special mode.
- **The camera cannot get under the island.** Bounds alone are not enough for
  that, because how far back a shot is framed depends on the viewport, so every
  candidate position — the composed shots, the orbit the visitor drives, and
  every intermediate frame of a transition — is tested against the island's own
  lathe profile plus a list of solid volumes the world registers for its
  buildings, and is pulled in to the last point on its approach line that
  clears them. The verification suite drags past every stop and zooms fully in
  and out at every destination, and fails if the camera is ever below the
  ground.
- **The campus turns itself.** The world is already moving when the visitor
  arrives, at a little under a degree a second, so the first thing it says is
  that it is a place rather than a picture. The turn is wall-clock motion, not
  frame-counted, so it takes the same time on a slow device as on a fast one.
  It yields the moment the visitor takes the camera — a drag, a scroll, a press
  on the sun — and picks up again a few seconds after they stop. Under
  `prefers-reduced-motion`, or with ambient movement paused, it does not run at
  all.
- **Every destination is on screen by default.** The ring of places is turned
  to the bearing that spreads them widest across the opening frame: before
  this, the workbench sat directly behind the observatory and could not be seen
  without dragging the camera round the island.
- **URLs are still real.** A deep link (`/cv/`, `/writing/<slug>/`) opens the
  world at that place with that document already open; refresh works; Back
  and Forward work.
- **The renderer never restarts.** Astro's router swaps the page around a
  persisted canvas, so moving between destinations keeps one WebGL context,
  one scene and one camera. Only the reading surface is replaced.
- **The camera composes for what is visible.** The reading surface is a side
  panel on desktop and a bottom sheet on a phone, and the identity card stands
  in the corner of the campus overview; the camera frames its subject in the
  region those leave free, on both axes, and the overview's distance is fitted
  to the island's real extent rather than picked by eye.
- **Captions are placed, not merely projected.** A caption that would collide
  with another, with the sun, with the identity card or with the open document
  becomes a marker — a 44px icon on the same anchor — and one that cannot fit
  even as a marker is dropped rather than piled on top of something. Markers
  show their name on hover, on focus, and on the way down under a finger, so a
  touch device never has to guess what a circle stands for.
- **Reading settles the scenery.** Ambient motion stops while a document is
  open and starts again when it closes.
- **Tapping the world works too.** A tap that never became a drag resolves
  against the scene: a caption under the finger is activated, otherwise the
  object itself answers - a destination travels, the observatory's light
  switch turns the lamps over.
- **The chrome is always there.** A compact bar holds the location readout,
  the **Map** (a labelled list of every place and document, as real links),
  **Reset view** and the **sound** controls. It takes the
  edge opposite the reading surface on a desktop and the top strip on a phone,
  so it stays reachable from the CV, an article, a case study or the contact
  card. No destination can be lost behind a building or a panel. The light is
  not in the bar: it is a switch in the world.
- **The camera is bounded and unambiguous.** A press only becomes a drag once
  it has travelled far enough to be unarguable, and a press that starts on a
  control belongs to that control - never to the camera.
- **Closing puts you back.** *Close* (and `Escape`) returns to the view the
  document was opened from, orbit and zoom included; the bar's other control
  goes to that place's list. Focus follows the document in and back out again.
- **The scenery is a solid body.** The island is one closed lathe profile —
  plateau, cliff, keel and both caps as a single watertight surface, with the
  ground's four bands painted per vertex and repainted when the light changes.
  Nothing relies on a double-sided material to hide a hole, because there are
  none: dragging to a low angle shows a finished underside rather than the back
  of the ground.

### Day and night

The light is one authoritative state, held as `data-theme` on `<html>` and
remembered in `localStorage` once the visitor makes an explicit choice. Until
then the system preference is honoured.

- **A switch in the world, and the sun itself.** A real sun hangs in the sky;
  choosing night runs it down its arc while the moon rises from the other end
  and the starfield comes up with it. The same value is driven by the brass
  **light switch standing on the observatory terrace** — a post with a lever and
  a glazed lamp, which a visitor can simply press — and by the sun and the moon,
  which are their own controls. The sun's rays, the moon's craters and the
  switch's own lever all follow it. There is no day/night button in the bar:
  the light is something you do to the place, not a setting in a toolbar.
- **The sky changes, not a filter.** Sky gradient, fog colour and density,
  hemisphere and key lights, the rim light, practical lamps, window and lamp
  emissives, the environment probe, exposure and the shadow tuning all take
  part in one coordinated **800ms** blend, and the sun and moon travel their
  arc as it goes. Stars come out for the night. There is no dark overlay over
  the canvas.
- **The bodies behave like sky.** They are a layer drawn in front of the
  scene, because a physically placed sky body is buried inside an island the
  camera looks down at — so they also fade out as they pass behind the island,
  which is what stops the moon landing on a roof like a decal.
- **The page changes with it.** Reading panels, forms, captions and the chrome
  cross-fade over the same period. Under `prefers-reduced-motion` the state
  applies immediately.
- **Nothing else moves.** Changing the light preserves the camera, the
  destination, the open document, the reading position and any form input.

### Music and interface sound

There is no track. The score is synthesised in the browser — see
[Third-party assets](#third-party-assets) for why — and it is on by default,
with no dialog and no question.

- **No entry card.** A visitor is not asked whether they want sound; they get
  it, and the control to turn it off is in the bar from the first frame. The
  music starts on the first gesture anywhere on the page, which is the earliest
  moment a browser will allow a context to run, and fades in over about three
  seconds at a conservative volume. Until it is actually playing, the control
  says "off" — the control never claims sound that is not happening.
- **Interface sounds are separate.** Every button, link and slider in the
  chrome and the reading panels answers with a small, soft tap: a low sine with
  a fast decay and a small downward bend, thinned so a burst of presses cannot
  stack into noise. It has its own bus, so it is heard with the music muted and
  gone when the visitor switches *Interface sounds* off in the sound panel.
- **One engine, and it survives navigation.** The engine is a module-level
  singleton, so the router swapping the page around it cannot create a second
  one — the same rule the renderer follows.
- **Controls in the bar, at every destination.** The sound control is its icon
  alone; mute, unmute, volume and the interface-sound switch live in one
  popover that stays reachable while the CV, an article or a case study is open.
  Volume and mute are remembered.
- **Honest about refusals.** A browser that blocks the context is reported in
  the panel rather than papered over, and a hidden tab pauses the music and
  resumes it only because the visitor had already asked for it — a pause the
  page performs is not the visitor changing their mind.

### Architecture

```
src/lib/world/
├── destinations.ts    the campus map, shared by server and client
├── state.ts           the page/shell contract: destination, surface, index,
│                      and the view to return to
├── document-state.ts  the pre-paint capability and theme decisions, carried
│                      across Astro's route swaps
├── theme-state.ts     the one day/night state, its storage, its events and
│                      the camera requests the interface is allowed to make
├── chrome.ts          the persistent controls (map, Home, reset, light, pause)
├── sound-controls.ts  mute, unmute and volume, wired to the one audio engine
├── audio.ts           the ambient score, synthesised with the Web Audio API
├── page-controls.ts   idempotent delegated page behaviour: forms, filters,
│                      contents rails, print, counters, scroll reveal
└── shell.ts           renderer lifecycle, camera composition, captions,
                       tap-versus-drag, quality, navigation, teardown

src/lib/observatory/  the world itself
├── theme.ts          palette bridge - reads the --world-* tokens from CSS and
│                      blends two themes for the transition
├── quality.ts        tiers, device detection, frame-time monitor
├── materials.ts      one material library, recoloured in place
├── parts.ts          procedural geometry: the island (one closed lathe
│                      profile), its band painting, clouds, vegetation
├── lighting.ts       sky dome, key/fill/rim/practical lights, the sky bodies
│                      and their arc, the PMREM environment
├── world.ts          the campus: six destinations, walkways, objects, the
│                      light switch, the cloud field, animation
└── camera.ts         shot-to-shot travel, bounded orbit, restorable state,
                      and the clearance test that keeps it above the island

src/components/world/
├── WorldShell.astro  the persisted canvas + captions + status
├── WorldChrome.astro the persisted controls + the branded failure screen
├── WorldWelcome.astro the once-per-visitor welcome: sound or silence
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
portfolio. Script being available is what selects the world; if the world
cannot start, it says so.

- With **no JavaScript at all** the mode attribute is simply absent, and the
  default CSS renders the same semantic documents as ordinary readable pages —
  which is also what search engines and browserless visitors get.
- **three.js is a dynamic import**, so a visitor whose browser cannot render
  the world never downloads the 3D bundle.
- **A failure is reported honestly.** A browser with no WebGL, a renderer that
  throws, a module that fails to download and a watchdog for a startup that
  never finishes all raise the same branded screen over the poster: what
  happened, **Try again**, **Reload the page**, and an explicit **Read the
  documents without the 3D scene**.
- **Reading without the scene is the visitor's choice, never a silent swap.**
  Choosing it keeps the same URLs, the same shell and the same semantic
  documents, remembers the decision for the session, and stops the screen
  asking. Trying again asks for the world back.
- **Retry rebuilds exactly one renderer**, disposing the failed attempt and its
  canvas first. Nothing is retried automatically for an unsupported
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
document is open, and the map menu's **ambient movement** control (or
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
  camera, object captions are links, the sun is a labelled toggle button, and
  a switch with its current state. All are reachable by Tab and activated by
  Enter.
- Captions that the reading surface covers, or that a building hides, are
  removed from the tab order rather than left focusable but invisible. A
  caption that survives a rebuild keeps focus, so travelling never drops the
  keyboard.
- Opening a document moves focus onto its heading; closing returns focus to
  the caption it was opened from, or to the map control.
- `prefers-reduced-motion` removes camera travel and ambient animation and
  applies the day/night change instantly; the map menu's **ambient movement**
  control does the same on demand.
- Text contrast meets WCAG AA in both themes (ratios above).
- Touch targets are at least 44x44 CSS pixels, safe areas are respected, and
  the reading sheet keeps its close, Home/Map and sun/moon switch reachable;
  ambient-motion pause is reachable inside the map menu.
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
npm run verify:music   -- http://localhost:4321  # the audio journey on its own
npm run inspect:world  -- http://localhost:4321  # screenshots + a JSON report
```

Screenshots land in `.screenshots/world/`. The suite checks navigation by
caption, tap-versus-drag, theme persistence across routes, document open and
close with camera and focus restoration, the physical switch, filters, forms,
deep links, Back/Forward, context loss and recovery, and five viewport widths.
It also drives the camera to every extreme it permits — past the azimuth stop,
to the shallowest elevation the control allows, and fully zoomed in and out at
every destination — and fails if the camera is ever below the ground.

Two smaller tools answer questions that come up while working on the world
rather than gating a release:

```bash
node tools/worldcheck/inspect.mjs http://localhost:4321   # screenshots + JSON report
node tools/worldcheck/inspect.mjs http://localhost:4321 --only camera
node tools/worldcheck/frame.mjs .screenshots/inspect/02-campus-day.png
```

`inspect.mjs` writes day and night frames of the campus and of each
destination, and reports the camera, the captions, and whether any two captions
overlap or land under the interface. `frame.mjs` measures where the island
actually lands in a frame, which is how the overview's framing was calibrated
rather than eyeballed.

`tools/worldcheck/probe.mjs` reads a named mesh's geometry back out of the
running world — its normals, its up/down face split, its bounds. That is how
the island's winding was found to be inside out: the built geometry reported
that two thirds of its faces pointed downward, which a screenshot can only ever
show as "dark".

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

| Asset                                       | Licence     | Use                  |
| ------------------------------------------- | ----------- | -------------------- |
| three.js                                    | MIT         | the campus renderer  |
| Fontsource: Fraunces, Inter, JetBrains Mono | SIL OFL 1.1 | self-hosted webfonts |

No textures, models, audio or paid assets are downloaded at runtime. All
geometry, the sky gradient, the mist falloff, the environment probe and the
poster illustration are generated locally.

**The music is generated too.** There is no track. `src/lib/world/audio.ts`
synthesises the score in the browser with the Web Audio API — slow pad chords,
a sparse piano figure drawn from the same harmony, a little filtered air and a
short synthesised room — so there is no third-party recording to license, no
file to download and no attribution to invent. The loop is seamless by
construction, because every event is scheduled on the audio clock ahead of
time rather than played back from a buffer.

It is optional in every sense: nothing is created until the visitor presses
"Enter with sound", and the sound controls in the bar mute, unmute and set the
volume from any destination. Volume and mute are remembered; playback is not
assumed. A browser that refuses to start the context is reported honestly
rather than papered over.

## Licence

MIT — see [LICENSE](LICENSE).
