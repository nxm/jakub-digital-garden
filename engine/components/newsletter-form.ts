export function renderNewsletterForm(): string {
  return `
<div class="newsletter-form" data-newsletter-form data-status="idle">
  <form class="newsletter-form__form" novalidate>
    <div class="newsletter-form__row">
      <input
        class="newsletter-form__input"
        data-newsletter-email
        type="email"
        inputmode="email"
        autocomplete="email"
        placeholder="your@email.com"
        aria-label="Email address"
        aria-invalid="false"
        required
      >
      <button class="newsletter-form__button" data-newsletter-submit type="submit" disabled>
        I'm in
      </button>
    </div>
    <p class="newsletter-form__hint newsletter-form__hint--error" data-newsletter-validation hidden>
      That email doesn’t look right.
    </p>
    <div class="newsletter-form__notice" data-newsletter-notice role="status" aria-live="polite" hidden></div>
  </form>
</div>`;
}
