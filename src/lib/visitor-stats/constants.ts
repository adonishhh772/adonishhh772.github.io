export const VISITOR_STATS_SESSION_KEY = 'visitor-stats:session';

export const VISITOR_STATS_API = {
  STATS: '/api/stats',
  VISIT: '/api/visit',
  GATHER_CLICK: '/api/gather-click',
} as const;

export const VISITOR_STATS_DOM = {
  ROOT: '[data-visitor-stats]',
  YOU: '[data-visitor-stats-you]',
  TOTAL: '[data-visitor-stats-total]',
  GATHER: '[data-visitor-stats-gather]',
} as const;

export const GATHER_TRACK_ATTRIBUTE = 'data-track-gather';
