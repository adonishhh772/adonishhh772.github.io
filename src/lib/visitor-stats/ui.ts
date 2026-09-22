import { VISITOR_STATS_DOM } from './constants';
import type { PublicStats, VisitResult } from './types';

function formatCount(value: number): string {
  return value.toLocaleString('en-GB');
}

export function paintVisitorStats(result: VisitResult | PublicStats, visitorNumber?: number): void {
  const root = document.querySelector<HTMLElement>(VISITOR_STATS_DOM.ROOT);
  if (!root) return;

  const you = document.querySelector<HTMLElement>(VISITOR_STATS_DOM.YOU);
  const total = document.querySelector<HTMLElement>(VISITOR_STATS_DOM.TOTAL);
  const gather = document.querySelector<HTMLElement>(VISITOR_STATS_DOM.GATHER);

  const number =
    visitorNumber ??
    ('visitorNumber' in result ? result.visitorNumber : undefined);

  if (you && number && number > 0) {
    you.textContent = `You are visitor #${formatCount(number)}.`;
  }
  if (total) {
    total.textContent = `${formatCount(result.totalUniqueVisitors)} unique visitors`;
  }
  if (gather) {
    gather.textContent = `Gather opened ${formatCount(result.gatherClicks)} times`;
  }

  root.hidden = false;
}
