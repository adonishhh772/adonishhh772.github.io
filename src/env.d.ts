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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
