import { GATHER_PROJECT_NAME, githubProjects } from '../../data/github-projects';

const gatherGithubProject = githubProjects.find((project) => project.name === GATHER_PROJECT_NAME);

export function normalizeOutboundHref(href: string): string {
  try {
    const url = new URL(href);
    url.hash = '';
    const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    url.pathname = path === '//' ? '/' : path;
    return url.toString();
  } catch {
    return href;
  }
}

export function isGatherLiveUrl(href: string): boolean {
  const gatherLiveUrl = gatherGithubProject?.liveUrl;
  if (!gatherLiveUrl) return false;
  return normalizeOutboundHref(href) === normalizeOutboundHref(gatherLiveUrl);
}
