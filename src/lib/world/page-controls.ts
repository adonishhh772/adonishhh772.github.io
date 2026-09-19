/**
 * Page controls.
 *
 * Astro's client router runs an inline script only once per session: it marks
 * every script it has already executed and skips it in the next document. A
 * script that binds directly to an element therefore works on a fresh load and
 * silently stops working after the first client-side navigation.
 *
 * Everything page-specific therefore lives here instead — delegated where the
 * event is what matters (print, filters, forms) and initialised per element
 * with a WeakSet guard where an observer is what matters (reveal, contents,
 * counters). Initialisation runs on the first load and again after every route
 * swap, and can never double-bind.
 */

const revealSeen = new WeakSet<Element>();
const contentsSeen = new WeakSet<Element>();
const counterSeen = new WeakSet<Element>();
const filterScopes = new WeakSet<Element>();

let watching = false;

function reduceMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/* ── Scroll reveal ───────────────────────────────────────────────────── */

let revealObserver: IntersectionObserver | null = null;

function initReveal(): void {
  const items = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (!items.length) return;
  if (reduceMotion() || !('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('is-visible'));
    return;
  }
  /* The class is dropped by every route swap, so it is re-applied here. */
  document.documentElement.classList.add('has-reveal');
  revealObserver ??= new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver?.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.08 },
  );
  items.forEach((item) => {
    if (revealSeen.has(item)) return;
    revealSeen.add(item);
    revealObserver?.observe(item);
  });
}

/* ── Contents rails ──────────────────────────────────────────────────── */

const contentsObserver =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const id = entry.target.id;
            document
              .querySelectorAll<HTMLElement>('[data-toc-link], [data-case-link]')
              .forEach((link) => {
                const key = link.dataset.tocLink ?? link.dataset.caseLink;
                link.classList.toggle('is-active', key === id);
              });
          });
        },
        { rootMargin: '-25% 0px -65% 0px', threshold: 0 },
      )
    : null;

function initContents(): void {
  if (!contentsObserver) return;
  const links = document.querySelectorAll<HTMLElement>('[data-toc-link], [data-case-link]');
  if (!links.length) return;
  document.querySelectorAll<HTMLElement>('[id]').forEach((section) => {
    if (contentsSeen.has(section)) return;
    /* The CV's own sections, and the rendered headings inside long-form
       prose — which is what a case study's or article's rail points at. */
    if (!section.matches('.cv-section, [data-contents-section], .prose h2[id]')) return;
    contentsSeen.add(section);
    contentsObserver?.observe(section);
  });
}

/* ── Counters ────────────────────────────────────────────────────────── */

const counterObserver =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            countUp(entry.target as HTMLElement);
            counterObserver?.unobserve(entry.target);
          });
        },
        { threshold: 0.4 },
      )
    : null;

function countUp(element: HTMLElement): void {
  const target = Number(element.dataset.countTo);
  if (!Number.isFinite(target)) return;
  const suffix = element.dataset.suffix ?? '';
  const duration = 900;
  let start: number | null = null;
  const frame = (now: number) => {
    if (start === null) start = now;
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = Math.round(target * eased).toLocaleString('en-GB') + suffix;
    if (progress < 1) requestAnimationFrame(frame);
  };
  element.textContent = '0' + suffix;
  requestAnimationFrame(frame);
}

function initCounters(): void {
  const values = document.querySelectorAll<HTMLElement>('[data-count-to]');
  if (!values.length) return;
  if (reduceMotion() || !counterObserver) return; // final numbers already in the HTML
  values.forEach((value) => {
    if (counterSeen.has(value)) return;
    counterSeen.add(value);
    counterObserver?.observe(value);
  });
}

/* ── Project filters ─────────────────────────────────────────────────── */

/**
 * Filter the project list.
 *
 * The marker sits on the filter row, but the cards it controls live in
 * sibling sections (the case studies and the open-source builds), so the
 * lookup is document-wide — which is also what keeps the two lists in step.
 */
function applyFilter(marker: HTMLElement, filter: string): void {
  const cards = document.querySelectorAll<HTMLElement>('[data-cat]');
  const blocks = document.querySelectorAll<HTMLElement>('[data-cat-block]');
  let shown = 0;
  cards.forEach((card) => {
    const match = filter === 'all' || card.dataset.cat === filter;
    card.hidden = !match;
    if (match) shown++;
  });
  blocks.forEach((block) => {
    block.hidden = !block.querySelector('[data-cat]:not([hidden])');
  });
  document.querySelectorAll<HTMLElement>('.filter-btn[data-filter]').forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const count = marker.querySelector<HTMLElement>('[data-filter-count]');
  if (count) count.textContent = `Showing ${shown} of ${cards.length} projects`;
}

function initFilters(): void {
  document.querySelectorAll<HTMLElement>('[data-work-filters]').forEach((marker) => {
    if (filterScopes.has(marker)) return;
    filterScopes.add(marker);
    /* The markup is server-rendered fresh, so the unfiltered view is correct
       and only the readout has to be filled in. */
    applyFilter(marker, marker.dataset.activeFilter || 'all');
  });
}

/* ── Forms ───────────────────────────────────────────────────────────── */

function statusOf(form: HTMLFormElement): HTMLElement | null {
  return form.querySelector<HTMLElement>('[data-form-status]');
}

function setStatus(element: HTMLElement | null, message: string, kind: 'ok' | 'error' | ''): void {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('form-status--ok', kind === 'ok');
  element.classList.toggle('form-status--error', kind === 'error');
}

/**
 * The contact form: a real submission to a real endpoint, with real validation
 * and honest reporting. A failure is never dressed up as a success.
 */
async function submitContact(form: HTMLFormElement): Promise<void> {
  const status = statusOf(form);
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) button.disabled = true;
  setStatus(status, 'Sending…', '');

  try {
    const response = await fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'application/json' },
    });
    const data = (await response.json().catch(() => ({}))) as { success?: boolean };
    if (response.ok && data.success) {
      form.reset();
      setStatus(status, 'Thanks — your message is on its way. I’ll reply to your email soon.', 'ok');
    } else {
      setStatus(
        status,
        'Something went wrong sending that. Please email abdabastola97@gmail.com instead.',
        'error',
      );
    }
  } catch {
    setStatus(status, 'Network problem — please email abdabastola97@gmail.com instead.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function onDocumentSubmit(event: Event): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (form.matches('[data-contact-form]')) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    void submitContact(form);
    return;
  }

  if (form.matches('[data-newsletter-form]')) {
    /* The provider's own page is the real submission; if the entry is not a
       valid address, say so rather than opening a page that will fail. */
    const field = form.querySelector<HTMLInputElement>('input[type="email"]');
    if (field && !field.checkValidity()) {
      event.preventDefault();
      setStatus(statusOf(form), 'That email address does not look right — please check it.', 'error');
      field.focus();
    }
  }
}

function onDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const printButton = target.closest('[data-print]');
  if (printButton) {
    event.preventDefault();
    window.print();
    return;
  }

  const filterButton = target.closest<HTMLElement>('.filter-btn[data-filter]');
  if (filterButton) {
    const marker = filterButton.closest<HTMLElement>('[data-work-filters]');
    const filter = filterButton.dataset.filter;
    if (marker && filter) {
      marker.dataset.activeFilter = filter;
      applyFilter(marker, filter);
    }
  }
}

/* ── Entry point ─────────────────────────────────────────────────────── */

/** Initialise whatever the current document contains. Safe to call often. */
export function initPageControls(): void {
  if (typeof document === 'undefined') return;
  initReveal();
  initContents();
  initCounters();
  initFilters();
}

export function watchPageControls(): void {
  if (typeof document === 'undefined') return;
  if (!watching) {
    watching = true;
    document.addEventListener('submit', onDocumentSubmit);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('astro:page-load', () => initPageControls());
  }
  initPageControls();
}
