// Sends newly added Reliable AI articles to Buttondown subscribers.
// Called by .github/workflows/newsletter-send.yml with INPUT_FILES (paths
// under src/content/writing) — creates an email from each article and
// sends it immediately via the Buttondown API.
import fs from 'node:fs';
import path from 'node:path';

const apiKey = process.env.BUTTONDOWN_API_KEY ?? '';
const site = process.env.SITE_URL ?? 'https://adonishhh772.github.io';
const input = process.env.INPUT_FILES ?? '';

if (!apiKey) {
  console.error('BUTTONDOWN_API_KEY is not set');
  process.exit(1);
}
if (!input.trim()) {
  console.log('No article files to send — nothing to do.');
  process.exit(0);
}

const base = 'src/content/writing';
const files = input
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((f) => (f.startsWith(base) ? f : path.join(base, path.basename(f))));

function frontmatterValue(frontmatter, key) {
  const line = frontmatter
    .split('\n')
    .find((l) => l.trim().startsWith(`${key}:`));
  if (!line) return undefined;
  let value = line.slice(line.indexOf(':') + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\'/g, "'").replace(/\\"/g, '"');
}

async function request(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    throw new Error(`Buttondown API ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.warn(`Skip (missing): ${file}`);
    continue;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) {
    console.warn(`Skip (no frontmatter): ${file}`);
    continue;
  }

  const frontmatter = fm[1];
  const title = frontmatterValue(frontmatter, 'title') ?? path.basename(file);
  const draft = (frontmatterValue(frontmatter, 'draft') ?? 'false')
    .trim()
    .toLowerCase();
  if (draft === 'true') {
    console.log(`Skip (draft): ${file}`);
    continue;
  }

  const slug = path.basename(file, '.md');
  const url = `${site.replace(/\/+$/, '')}/writing/${slug}/`;
  const body = raw.slice(fm[0].length).trim();

  const emailBody = `${body}\n\n---\n\n*Originally published on [${site.replace(
    /^https?:\/\//,
    ''
  )}](${url}) — full archive at ${site}/writing/.*`;

  const created = await request('https://api.buttondown.com/v1/emails', {
    method: 'POST',
    body: JSON.stringify({
      subject: title,
      body: emailBody,
      canonical_url: url,
      slug,
      metadata: { source: 'github-pages-site' },
    }),
  });

  const emailId = created.id;
  if (!emailId) {
    throw new Error(`Create email returned no id: ${JSON.stringify(created)}`);
  }

  await request(`https://api.buttondown.com/v1/emails/${emailId}/send-draft`, {
    method: 'POST',
    body: '{}',
  });

  console.log(`Sent to subscribers: "${title}" (${emailId}) — ${url}`);
}
