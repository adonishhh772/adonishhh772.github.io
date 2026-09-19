/**
 * The campus map.
 *
 * Shared by the server (the dock, the page state attributes) and the client
 * (the shell that frames each location), so a destination can never exist in
 * one and not the other.
 *
 * Destinations are *places*. Surfaces are *documents* read at a place. One
 * place hosts several documents — the studio holds the CV and the biography,
 * the workshop holds the case studies, the library holds every article.
 */

export type DestinationId =
  | 'campus'
  | 'studio'
  | 'workshop'
  | 'library'
  | 'workbench'
  | 'contact';

export type SurfaceKind =
  | 'none'
  | 'cv'
  | 'about'
  | 'projects'
  | 'project'
  | 'articles'
  | 'article'
  | 'repos'
  | 'contact'
  | 'thanks'
  | 'welcome'
  | 'missing';

export interface DestinationMeta {
  id: DestinationId;
  /** Dock label. */
  label: string;
  /** The URL that renders this destination. */
  href: string;
  /** Longer name used in the dock's tooltip and the location readout. */
  name: string;
  /**
   * Which side the reading surface occupies. The camera frames the location
   * on the opposite side so the place is never hidden behind the document.
   */
  panel: 'left' | 'right';
}

export const DESTINATIONS: DestinationMeta[] = [
  {
    id: 'campus',
    label: 'Home',
    name: 'The observatory campus',
    href: '/',
    panel: 'right',
  },
  {
    id: 'studio',
    label: 'CV',
    name: 'Personal studio',
    href: '/cv/',
    panel: 'right',
  },
  {
    id: 'workshop',
    label: 'Projects',
    name: 'Project workshop',
    href: '/work/',
    panel: 'left',
  },
  {
    id: 'library',
    label: 'Writing',
    name: 'Reliable AI library',
    href: '/writing/',
    panel: 'left',
  },
  {
    id: 'workbench',
    label: 'Open source',
    name: 'Open-source workbench',
    href: '/open-source/',
    panel: 'right',
  },
  {
    id: 'contact',
    label: 'Contact',
    name: 'Contact station',
    href: '/contact/',
    panel: 'right',
  },
];

export const DESTINATION_IDS = DESTINATIONS.map((d) => d.id);

export function destinationMeta(id: DestinationId): DestinationMeta {
  return DESTINATIONS.find((d) => d.id === id) ?? DESTINATIONS[0];
}

export function isDestinationId(value: string | undefined | null): value is DestinationId {
  return Boolean(value) && DESTINATION_IDS.includes(value as DestinationId);
}

export function isSurfaceKind(value: string | undefined | null): value is SurfaceKind {
  return Boolean(value);
}

/**
 * Which destinations show captions for their own objects (articles, project
 * installations, repository plaques) rather than the campus-wide markers.
 */
export function hostsObjects(id: DestinationId): boolean {
  return id === 'studio' || id === 'workshop' || id === 'library' || id === 'workbench' || id === 'contact';
}

/**
 * The page each place opens when you select the place itself, rather than one
 * of its objects. Every destination needs one: the world is the only way to
 * get around, so a place with no way in would be unreachable. The studio is
 * absent because its two documents are its objects.
 */
export const PLACE_INDEX: Partial<Record<DestinationId, { label: string; meta: string; href: string }>> = {
  workshop: { label: 'All projects', meta: 'Index', href: '/work/' },
  library: { label: 'All writing', meta: 'Archive', href: '/writing/' },
  workbench: { label: 'All repositories', meta: 'Index', href: '/open-source/' },
  contact: { label: 'Contact', meta: 'Email · LinkedIn · booking', href: '/contact/' },
};

/**
 * The destination menu.
 *
 * A hotspot can legitimately be behind a building, behind the reading surface
 * or simply off screen; this is the guaranteed route to every place and every
 * document, and it is rendered from the same map the world is built from, as
 * real links, so it works with no renderer at all.
 */
export interface WorldNavEntry {
  id: string;
  /** Menu label. */
  label: string;
  /** What this place holds. */
  detail: string;
  name: string;
  href: string;
  destination: DestinationId;
}

export const WORLD_NAV: WorldNavEntry[] = [
  {
    id: 'campus',
    label: 'Home',
    detail: 'The whole campus',
    name: 'The observatory campus',
    href: '/',
    destination: 'campus',
  },
  {
    id: 'studio',
    label: 'Personal studio',
    detail: 'Biography and CV',
    name: 'Personal studio',
    href: '/cv/',
    destination: 'studio',
  },
  {
    id: 'studio-about',
    label: 'Biography',
    detail: 'The longer story',
    name: 'Personal studio',
    href: '/about/',
    destination: 'studio',
  },
  {
    id: 'workshop',
    label: 'Project workshop',
    detail: 'Projects and full case studies',
    name: 'Project workshop',
    href: '/work/',
    destination: 'workshop',
  },
  {
    id: 'library',
    label: 'Reliable AI library',
    detail: 'Every article and the newsletter',
    name: 'Reliable AI library',
    href: '/writing/',
    destination: 'library',
  },
  {
    id: 'workbench',
    label: 'Open-source workbench',
    detail: 'Curated repositories',
    name: 'Open-source workbench',
    href: '/open-source/',
    destination: 'workbench',
  },
  {
    id: 'contact',
    label: 'Contact station',
    detail: 'Message, email, social and booking',
    name: 'Contact station',
    href: '/contact/',
    destination: 'contact',
  },
];
