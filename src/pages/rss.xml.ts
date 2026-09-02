import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { site, newsletter } from '../site.config';

export async function GET(context: { site: URL | string | undefined }) {
  const posts = (await getCollection('writing'))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  return rss({
    title: `${newsletter.name} — ${site.name}`,
    description: newsletter.tagline,
    site: context.site ?? site.url,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/writing/${post.id}/`,
      categories: post.data.tags,
    })),
    customData: '<language>en-gb</language>',
  });
}
