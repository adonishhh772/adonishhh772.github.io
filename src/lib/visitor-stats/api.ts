import { VISITOR_STATS_API } from './constants';
import type { PublicStats, VisitResult } from './types';

export function readStatsApiBase(): string | null {
  const base = import.meta.env.PUBLIC_VISITOR_STATS_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

export function isVisitorStatsEnabled(): boolean {
  return readStatsApiBase() !== null;
}

function apiUrl(path: string): string | null {
  const base = readStatsApiBase();
  if (!base) return null;
  return `${base}${path}`;
}

export async function fetchPublicStats(): Promise<PublicStats | null> {
  const url = apiUrl(VISITOR_STATS_API.STATS);
  if (!url) return null;
  try {
    const response = await fetch(url, { method: 'GET', credentials: 'omit' });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<PublicStats>;
    return {
      totalUniqueVisitors: Number(data.totalUniqueVisitors) || 0,
      gatherClicks: Number(data.gatherClicks) || 0,
    };
  } catch {
    return null;
  }
}

export async function registerVisit(): Promise<VisitResult | null> {
  const url = apiUrl(VISITOR_STATS_API.VISIT);
  if (!url) return null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<VisitResult>;
    return {
      visitorNumber: Number(data.visitorNumber) || 0,
      isNew: Boolean(data.isNew),
      totalUniqueVisitors: Number(data.totalUniqueVisitors) || 0,
      gatherClicks: Number(data.gatherClicks) || 0,
    };
  } catch {
    return null;
  }
}

export async function registerGatherClick(): Promise<PublicStats | null> {
  const url = apiUrl(VISITOR_STATS_API.GATHER_CLICK);
  if (!url) return null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<PublicStats>;
    return {
      totalUniqueVisitors: Number(data.totalUniqueVisitors) || 0,
      gatherClicks: Number(data.gatherClicks) || 0,
    };
  } catch {
    return null;
  }
}
