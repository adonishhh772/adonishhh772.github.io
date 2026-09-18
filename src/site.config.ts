/**
 * ─────────────────────────────────────────────────────────────────────
 * Single source of truth for site copy, navigation and external links.
 *
 * Edit THIS file to change: social links, the coffee link, newsletter
 * endpoint fallbacks, navigation labels, hero copy or the stations that
 * make up the AI Observatory on the home page.
 *
 * All placeholders are marked with a "TODO" comment so you can find and
 * replace them quickly.
 * ─────────────────────────────────────────────────────────────────────
 */

const env = import.meta.env;

/** Deployment base path ("/" for user sites, "/<repo>/" for project sites). */
const baseUrl = import.meta.env.BASE_URL ?? '/';

export const site = {
  /** Canonical origin — the live site root domain. */
  url: 'https://adonishhh772.github.io',
  title: 'Abd Bastola — Lead AI Engineer',
  name: 'Abd Bastola',
  role: 'Lead AI Engineer building reliable enterprise AI systems.',
  location: 'London',
  metaDescription:
    'Abd Bastola is a Lead AI Engineer in London (AWTG Ltd) building production-ready enterprise AI systems — RAG, GraphRAG, AI agents, evaluation, guardrails and responsible delivery across Azure AI Foundry and GCP. Publisher of the Reliable AI newsletter.',
};

/**
 * Deployment origin, mirroring astro.config.mjs: GitHub Actions injects
 * GITHUB_REPOSITORY (owner/repo). A repo named <owner>.github.io owned by
 * <owner> is a user site at the domain root; anything else is a project
 * site on the owner's pages domain. Falls back to the spec's user-site
 * identity for local development.
 */
export function deploymentOrigin(): string {
  const repoEnv = process.env.GITHUB_REPOSITORY ?? '';
  const [repoOwner, repoName] = repoEnv.split('/');
  if (repoName && repoName === `${repoOwner}.github.io`) {
    return `https://${repoName}`;
  }
  if (repoName) {
    return `https://${repoOwner}.github.io`;
  }
  return site.url;
}

/**
 * Prefix a root-relative path (e.g. "/work") with the deployment base.
 * GitHub Pages project sites are served under "/<repo>/"; user sites and
 * local dev run at the root, where paths are returned unchanged.
 */
export function rootUrl(path: string): string {
  if (baseUrl === '/') return path;
  const trimmed = baseUrl.replace(/\/+$/, '');
  return path === '/' ? `${trimmed}/` : `${trimmed}${path}`;
}

/** Absolute URL (origin + base + path) for SEO feeds and robots. */
export function absoluteUrl(path: string): string {
  return `${deploymentOrigin().replace(/\/+$/, '')}${rootUrl(path)}`;
}

/** External profile links — edit once here; navigation and footer use them. */
export const social = {
  github: 'https://github.com/adonishhh772',
  linkedin: 'https://www.linkedin.com/in/abda-bastola-b0447b13a/',
};

/**
 * Primary navigation — name, then the four places worth going, plus an
 * unmissable CV link. External profiles live in the footer and on /contact.
 */
export const nav = {
  primary: [
    { label: 'Work', href: '/work' },
    { label: 'Writing', href: '/writing' },
    { label: 'About', href: '/about' },
    { label: 'Contact', href: '/contact' },
  ],
  /** Rendered as a distinct outlined action in the header. */
  cv: { label: 'CV', href: '/cv' },
  external: [
    { label: 'GitHub', href: social.github },
    { label: 'LinkedIn', href: social.linkedin },
  ],
};

/**
 * Home-page hero. The headline is deliberately literal: a first-time
 * visitor should understand the work within five seconds.
 */
export const hero = {
  eyebrow: `Lead AI Engineer · ${site.location}`,
  headline: 'I build AI systems people can rely on.',
  lead: 'Production-grade agents, RAG and GraphRAG platforms for enterprise teams — with the unglamorous parts designed in: evaluation, guardrails, observability and clear limits.',
  primary: { label: 'Explore my work', href: '/work' },
  secondary: { label: 'Read Reliable AI', href: '/writing' },
  currently:
    'Building and delivering enterprise AI systems at AWTG in London — including the KAI platform.',
  stage: {
    /** The explicit way into the interactive world. */
    exploreLabel: 'Explore the world',
    exitLabel: 'Exit exploration',
    resetLabel: 'Reset view',
    menuLabel: 'Find a station',
    pauseLabel: 'Pause motion',
    resumeLabel: 'Resume motion',
    simpleLabel: 'Simple view',
    worldLabel: 'Interactive view',
    loadingLabel: 'Assembling the observatory',
    readyLabel: 'Observatory online — 6 stations',
    errorLabel: 'Interactive view unavailable',
    posterAlt:
      'Illustration of a miniature AI observatory on a floating island: a domed instrument at the centre, a project pavilion, a knowledge-graph garden, a signal tower, a studio and a contact beacon.',
  },
};

/** Reliable AI — the newsletter. */
export const newsletter = {
  name: 'Reliable AI',
  tagline:
    'Notes on building production-ready AI agents, RAG systems, evaluation and enterprise AI delivery.',
  signup: {
    headline: 'Get Reliable AI in your inbox.',
    copy: 'A concise daily briefing on enterprise AI agents, RAG, evaluation, security and the ideas worth understanding before they become industry noise.',
    buttonLabel: 'Subscribe to the daily briefing',
    inputPlaceholder: 'you@company.com',
    /** Shown only while no form endpoint is configured. */
    launchingMessage:
      'Daily issues are launching soon. Follow on LinkedIn in the meantime.',
    followLabel: 'Follow on LinkedIn',
  },
  /**
   * Newsletter form endpoint. The value comes from the NEWSLETTER_FORM_URL
   * environment variable (see `.env.example`). When empty, the site renders
   * a graceful "launching soon" placeholder instead of a broken form.
   */
  formUrl: env.NEWSLETTER_FORM_URL ?? '',
  rssPath: rootUrl('/rss.xml'),
};

/** Support card copy + link. */
export const coffee = {
  copy: 'If these notes help you think more clearly about AI, you can support the writing with a coffee.',
  buttonLabel: 'Buy me a coffee',
  url: 'https://buymeacoffee.com/abdabastola',
};

/** Contact details. */
export const contact = {
  email: 'abdabastola97@gmail.com',
  phone: '+44 7459 687089',
  location: 'London, UK',
  /**
   * Contact form endpoint (Web3Forms — free, no backend required).
   * Set CONTACT_ACCESS_KEY locally in .env and as an Actions variable in CI.
   * When empty, the contact page falls back to a mailto link.
   */
  formEndpoint: 'https://api.web3forms.com/submit',
  formAccessKey: env.CONTACT_ACCESS_KEY ?? '',
};

/** Meeting scheduling. */
export const booking = {
  label: 'Schedule a meeting',
  heading: 'Book a 30-minute call',
  copy: 'Pick a slot that works for you — we can talk through your AI systems, architecture or delivery questions.',
  /**
   * Scheduling link (e.g. a free Cal.com or Calendly page).
   * Set BOOKING_URL locally in .env and as an Actions variable in CI.
   * When empty, the site offers email instead.
   */
  url: env.BOOKING_URL ?? '',
};

/* ── The AI Observatory ─────────────────────────────────────────────────
   Stations of the miniature world on the home page. Every station is a
   real destination: `links` always point at existing routes, and `label`
   is the plain name that menus and assistive technology meet first.
   `alias` is the in-world installation name, shown as secondary detail.

   `exhibits` (Work only) is resolved against the projects collection at
   build time, so the pavilion always shows the real selected work.
   ──────────────────────────────────────────────────────────────────── */

export interface StationLink {
  label: string;
  href: string;
  /** External links open in a new tab. */
  external?: boolean;
}

export type StationId =
  | 'observatory'
  | 'work'
  | 'knowledge'
  | 'writing'
  | 'studio'
  | 'contact';

export interface Station {
  id: StationId;
  /** Plain, unambiguous name — used in menus and accessible labels. */
  label: string;
  /** The in-world name of the installation. */
  alias: string;
  /** One line for the station menu. */
  blurb: string;
  /** The installation's job, shown in its preview panel. */
  body: string;
  /** Facts shown as key/value rows in the preview panel. */
  facts: { k: string; v: string }[];
  /** Real links out of the world. */
  links: StationLink[];
  /** Project ids rendered as exhibits (Work pavilion only). */
  exhibits?: string[];
  /** A discoverable light marker hidden near this station. */
  discovery?: { label: string };
}

export const stations: Station[] = [
  {
    id: 'observatory',
    label: 'Overview',
    alias: 'Central observatory',
    blurb: 'What I do, in one room.',
    body: 'The instrument at the centre of the site. I design and deliver production AI systems — multi-agent RAG, GraphRAG, evaluation harnesses and the guardrails that make an enterprise willing to depend on them.',
    facts: [
      { k: 'Role', v: 'Lead AI Engineer, AWTG Ltd' },
      { k: 'Based', v: `${site.location}, UK` },
      { k: 'Focus', v: 'Reliable enterprise AI' },
    ],
    links: [
      { label: 'Selected work', href: '/work' },
      { label: 'How I work', href: '/about' },
    ],
    discovery: { label: 'Observatory lantern' },
  },
  {
    id: 'work',
    label: 'Work',
    alias: 'Work pavilion',
    blurb: 'Three delivered systems.',
    body: 'Three exhibits, each a real engagement: an enterprise knowledge assistant at scale, a GraphRAG platform for dense learning content, and a reinforcement-learning approach to telecom energy use.',
    facts: [
      { k: 'Exhibits', v: '3 case studies' },
      { k: 'Domains', v: 'Enterprise AI · EdTech · Telecom' },
    ],
    links: [{ label: 'All work', href: '/work' }],
    exhibits: ['kai', 'education-platform', 'hyperran'],
    discovery: { label: 'Pavilion marker' },
  },
  {
    id: 'knowledge',
    label: 'Knowledge graph',
    alias: 'Knowledge garden',
    blurb: 'Retrieval as a living network.',
    body: 'A sculptural graph of entities and relationships — the shape a corpus takes when you stop treating passages in isolation. This is the retrieval idea behind the GraphRAG education platform.',
    facts: [
      { k: 'Built with', v: 'Neo4j · Docling · Azure' },
      { k: 'Theme', v: 'Connected, citable answers' },
    ],
    links: [
      { label: 'Read the case study', href: '/work/education-platform' },
      { label: 'All work', href: '/work' },
    ],
    discovery: { label: 'Garden marker' },
  },
  {
    id: 'writing',
    label: 'Writing',
    alias: 'Signal tower',
    blurb: `${newsletter.name}, broadcasting.`,
    body: 'The mast that carries the newsletter. Reliable AI is independent writing on production agents, RAG, evaluation and the parts of enterprise AI delivery that decide whether a system survives contact with real users.',
    facts: [
      { k: 'Publication', v: newsletter.name },
      { k: 'Cadence', v: 'Concise, regular' },
    ],
    links: [
      { label: 'Read Reliable AI', href: '/writing' },
      { label: 'RSS feed', href: '/rss.xml' },
    ],
    discovery: { label: 'Tower beacon' },
  },
  {
    id: 'studio',
    label: 'About',
    alias: 'Personal studio',
    blurb: 'Who is building this.',
    body: 'A small workroom at the edge of the island: biography, the path from machine-learning engineering to leading enterprise GenAI delivery, and the full CV in web or print form.',
    facts: [
      { k: 'Experience', v: 'Since 2017' },
      { k: 'Education', v: 'MSc Computing · BSc Computing' },
    ],
    links: [
      { label: 'About me', href: '/about' },
      { label: 'View CV', href: '/cv' },
    ],
  },
  {
    id: 'contact',
    label: 'Contact',
    alias: 'Contact beacon',
    blurb: 'Open a channel.',
    body: 'The beacon is always lit. Email is the fastest route; LinkedIn works too, and if a scheduling link is configured you can book a 30-minute call directly.',
    facts: [
      { k: 'Location', v: contact.location },
      { k: 'Reply time', v: 'Usually a day or two' },
    ],
    links: [
      { label: 'Contact options', href: '/contact' },
      { label: 'Email', href: `mailto:${contact.email}` },
      { label: 'LinkedIn', href: social.linkedin, external: true },
    ],
  },
];
