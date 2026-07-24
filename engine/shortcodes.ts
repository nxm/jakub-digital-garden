import { renderNewsletterForm } from "./components/newsletter-form";

const NEWSLETTER_FORM_LINE_RE = /^\s*<NewsletterForm\s*\/>\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export function renderShortcodes(content: string): string {
  let inFence = false;

  return content
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }

      if (!inFence && NEWSLETTER_FORM_LINE_RE.test(line)) {
        return renderNewsletterForm();
      }

      return line;
    })
    .join("\n");
}
