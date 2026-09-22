export interface Env {
  VISITOR_STATS: KVNamespace;
  ALLOWED_ORIGINS: string;
  IP_HASH_SALT: string;
}

interface StoredStats {
  totalUniqueVisitors: number;
  gatherClicks: number;
}

interface VisitResponse {
  visitorNumber: number;
  isNew: boolean;
  totalUniqueVisitors: number;
  gatherClicks: number;
}

const STATS_KEY = 'stats:v1';
const IP_PREFIX = 'ip:v1:';

const DEFAULT_STATS: StoredStats = {
  totalUniqueVisitors: 0,
  gatherClicks: 0,
};

function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isAllowedOrigin(origin: string | null, env: Env): boolean {
  if (!origin) return false;
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  return allowed.includes(origin);
}

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (origin && isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  env: Env,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin, env),
    },
  });
}

async function readStats(kv: KVNamespace): Promise<StoredStats> {
  const raw = await kv.get(STATS_KEY);
  if (!raw) return { ...DEFAULT_STATS };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredStats>;
    return {
      totalUniqueVisitors: Number(parsed.totalUniqueVisitors) || 0,
      gatherClicks: Number(parsed.gatherClicks) || 0,
    };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

async function writeStats(kv: KVNamespace, stats: StoredStats): Promise<void> {
  await kv.put(STATS_KEY, JSON.stringify(stats));
}

async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return 'unknown';
}

async function recordVisit(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin, env)) {
    return jsonResponse({ error: 'forbidden' }, 403, origin, env);
  }
  if (!env.IP_HASH_SALT) {
    return jsonResponse({ error: 'misconfigured' }, 500, origin, env);
  }

  const ip = clientIp(request);
  const ipKey = `${IP_PREFIX}${await hashIp(ip, env.IP_HASH_SALT)}`;
  const stats = await readStats(env.VISITOR_STATS);

  const existingNumber = await env.VISITOR_STATS.get(ipKey);
  if (existingNumber) {
    const visitorNumber = Number(existingNumber);
    const payload: VisitResponse = {
      visitorNumber,
      isNew: false,
      totalUniqueVisitors: stats.totalUniqueVisitors,
      gatherClicks: stats.gatherClicks,
    };
    return jsonResponse(payload, 200, origin, env);
  }

  const visitorNumber = stats.totalUniqueVisitors + 1;
  stats.totalUniqueVisitors = visitorNumber;
  await writeStats(env.VISITOR_STATS, stats);
  await env.VISITOR_STATS.put(ipKey, String(visitorNumber));

  const payload: VisitResponse = {
    visitorNumber,
    isNew: true,
    totalUniqueVisitors: stats.totalUniqueVisitors,
    gatherClicks: stats.gatherClicks,
  };
  return jsonResponse(payload, 200, origin, env);
}

async function recordGatherClick(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin, env)) {
    return jsonResponse({ error: 'forbidden' }, 403, origin, env);
  }

  const stats = await readStats(env.VISITOR_STATS);
  stats.gatherClicks += 1;
  await writeStats(env.VISITOR_STATS, stats);

  return jsonResponse(
    {
      gatherClicks: stats.gatherClicks,
      totalUniqueVisitors: stats.totalUniqueVisitors,
    },
    200,
    origin,
    env,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env),
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/stats') {
      const stats = await readStats(env.VISITOR_STATS);
      return jsonResponse(stats, 200, origin, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/visit') {
      return recordVisit(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/gather-click') {
      return recordGatherClick(request, env);
    }

    return jsonResponse({ error: 'not_found' }, 404, origin, env);
  },
};
