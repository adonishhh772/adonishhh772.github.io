import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

/**
 * Writing collection — the "Reliable AI" newsletter articles.
 * Each `.md` file in `src/content/writing/` becomes a page under
 * `/writing/[slug]` and an item in the RSS feed. The slug is the
 * file name (e.g. `my-post.md` → `/writing/my-post`).
 */
const writing = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/writing' }),
  schema: z.object({
    title: z.string(),
    /** Short summary used on cards, meta descriptions and RSS. */
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    /** Newsletter issue number, shown as a small label. */
    issue: z.number().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

/**
 * Projects collection — anonymised case studies.
 * Each `.md` file in `src/content/projects/` becomes a page under
 * `/work/[slug]` and a card on the home page and /work index.
 */
const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    /** Short display title used on cards, e.g. "KAI". */
    shortTitle: z.string(),
    /** One- or two-line summary used on cards and index pages. */
    summary: z.string(),
    /** A longer lead paragraph opening the case study. */
    context: z.string(),
    /** Short descriptor shown on cards, e.g. "Enterprise delivery". */
    tag: z.string(),
    /** Technical themes shown as chips on cards. */
    themes: z.array(z.string()),
    /** Optional public links (product, marketing, sources). */
    links: z
      .array(z.object({ label: z.string(), url: z.string() }))
      .default([]),
    /** "Reading" label shown in the case study header. */
    readingTime: z.string().default('6 min read'),
  }),
});

export const collections = { writing, projects };
