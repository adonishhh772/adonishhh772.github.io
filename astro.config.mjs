// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

/**
 * Deployment target resolution.
 *
 * GitHub Actions injects GITHUB_REPOSITORY (e.g. "adonishhh772/abdbastola.github.io").
 * - If the repo is <owner>.github.io owned by <owner>  → GitHub Pages user site,
 *   served at the domain root  (base "/").
 * - Otherwise the repo is a project site, served under /<repo>/ on the owner's
 *   pages domain (base "/<repo>/").
 *
 * Local dev has no GITHUB_REPOSITORY, so it defaults to the intended user-site
 * identity (https://abdbastola.github.io) per the project spec.
 */
const repoEnv = process.env.GITHUB_REPOSITORY ?? '';
const [repoOwner, repoName] = repoEnv.split('/');
const isUserSite = Boolean(repoName && repoName === `${repoOwner}.github.io`);

const site =
  isUserSite
    ? `https://${repoName}`
    : repoName
      ? `https://${repoOwner}.github.io`
      : 'https://abdbastola.github.io';

const base = isUserSite || !repoName ? '/' : `/${repoName}/`;

export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'ignore',
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
    format: 'directory',
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/404'),
    }),
  ],
});
