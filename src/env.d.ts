/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Endpoint the newsletter sign-up form POSTs to.
   * Leave unset/empty to show the "launching soon" placeholder instead.
   */
  readonly NEWSLETTER_FORM_URL?: string;

  /**
   * Web3Forms access key that powers the contact form.
   * Leave unset/empty to fall back to a mailto link.
   */
  readonly CONTACT_ACCESS_KEY?: string;

  /**
   * Scheduling link (Cal.com, Calendly, …) for the "Schedule a meeting"
   * actions. Leave unset/empty to offer email instead.
   */
  readonly BOOKING_URL?: string;

  /**
   * Base URL of the visitor-stats worker (no trailing slash). When set, the site
   * shows live visitor numbers and records unique visitors + Gather clicks.
   */
  readonly PUBLIC_VISITOR_STATS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The small plain-DOM bridge the world shell uses to report a startup failure
 * even when the module that would normally draw the interface never loaded.
 */
interface WorldAlertBridge {
  (message?: string): void;
  hide?: () => void;
}

interface AmbientsState {
  playing: boolean;
  wanted: boolean;
  volume: number;
  blocked: boolean;
}

interface Window {
  __worldAlert?: WorldAlertBridge;
  /** Set once the delegated theme handler is live. */
  __abdThemeDelegated?: boolean;
  /** Set once the header's scroll listener is live. */
  __abdHeaderScroll?: boolean;
  /** Read-only view of the live world, for verification and support. */
  __worldDebug?: () => unknown;
  /** Read-only view of the music, for verification and support. */
  __worldAudio?: () => AmbientsState;
}
