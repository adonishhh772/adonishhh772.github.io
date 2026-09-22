import assert from 'node:assert/strict';
import test from 'node:test';

const GATHER_LIVE_URL = 'https://adonishhh772.github.io/Transcriber-agent/';

function normalizeOutboundHref(href) {
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

function isGatherLiveUrl(href) {
  return normalizeOutboundHref(href) === normalizeOutboundHref(GATHER_LIVE_URL);
}

test('normalizeOutboundHref normalizes trailing slash', () => {
  const a = normalizeOutboundHref('https://adonishhh772.github.io/Transcriber-agent');
  const b = normalizeOutboundHref('https://adonishhh772.github.io/Transcriber-agent/');
  assert.equal(a, b);
});

test('isGatherLiveUrl matches Gather deployment', () => {
  assert.equal(isGatherLiveUrl(GATHER_LIVE_URL), true);
  assert.equal(isGatherLiveUrl('https://example.com/'), false);
});
