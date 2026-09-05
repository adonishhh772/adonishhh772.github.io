/**
 * ─────────────────────────────────────────────────────────────────────
 * Single source of truth for site copy, navigation and external links.
 *
 * Edit THIS file to change: social links, the coffee link, newsletter
 * endpoint fallbacks, navigation labels or hero copy.
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

/** Primary navigation. Internal pages first, then external links. */
export const nav = {
  primary: [
    { label: 'Work', href: '/work' },
    { label: 'Writing', href: '/writing' },
    { label: 'About', href: '/about' },
    { label: 'CV', href: '/cv' },
  ],
  external: [
    { label: 'GitHub', href: social.github },
    { label: 'LinkedIn', href: social.linkedin },
  ],
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
};
