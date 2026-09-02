/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Endpoint the newsletter sign-up form POSTs to.
   * Leave unset/empty to show the "launching soon" placeholder instead.
   */
  readonly NEWSLETTER_FORM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
