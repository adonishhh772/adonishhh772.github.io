// Dynamic robots.txt so the Sitemap URL matches the actual deployment
// (origin + base path for GitHub Pages project sites).
import { absoluteUrl } from '../site.config';

export async function GET() {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${absoluteUrl('/sitemap-index.xml')}`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
