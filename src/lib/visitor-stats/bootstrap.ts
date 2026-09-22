import { fetchPublicStats, isVisitorStatsEnabled, registerGatherClick, registerVisit } from './api';
import { VISITOR_STATS_SESSION_KEY, GATHER_TRACK_ATTRIBUTE } from './constants';
import { isGatherLiveUrl } from './gather';
import { paintVisitorStats } from './ui';

let wired = false;

function readCachedVisit(): { visitorNumber: number } | null {
  try {
    const raw = sessionStorage.getItem(VISITOR_STATS_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { visitorNumber?: number };
    const visitorNumber = Number(parsed.visitorNumber);
    if (!Number.isFinite(visitorNumber) || visitorNumber <= 0) return null;
    return { visitorNumber };
  } catch {
    return null;
  }
}

function writeCachedVisit(visitorNumber: number): void {
  try {
    sessionStorage.setItem(
      VISITOR_STATS_SESSION_KEY,
      JSON.stringify({ visitorNumber }),
    );
  } catch {
    /* storage unavailable */
  }
}

async function syncVisitorStats(): Promise<void> {
  if (!isVisitorStatsEnabled()) return;

  const cached = readCachedVisit();
  const visit = cached ? null : await registerVisit();
  const stats = visit ?? (await fetchPublicStats());

  if (visit) {
    writeCachedVisit(visit.visitorNumber);
    paintVisitorStats(visit);
    return;
  }

  if (stats) {
    paintVisitorStats(stats, cached?.visitorNumber);
  }
}

function onGatherLinkClick(event: MouseEvent): void {
  if (!isVisitorStatsEnabled()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest('a[href]');
  if (!(link instanceof HTMLAnchorElement)) return;

  const tagged = link.hasAttribute(GATHER_TRACK_ATTRIBUTE);
  const href = link.href;
  if (!tagged && !isGatherLiveUrl(href)) return;

  void registerGatherClick().then((stats) => {
    if (!stats) return;
    const cached = readCachedVisit();
    paintVisitorStats(stats, cached?.visitorNumber);
  });
}

export function bootstrapVisitorStats(): void {
  if (typeof document === 'undefined' || !isVisitorStatsEnabled()) return;
  if (!wired) {
    wired = true;
    document.addEventListener('click', onGatherLinkClick, { capture: true });
    document.addEventListener('astro:page-load', () => {
      void syncVisitorStats();
    });
  }
  void syncVisitorStats();
}
