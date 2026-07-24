// Newsletter signup wiring for <NewsletterForm /> shortcodes.
(() => {
  if (typeof window === "undefined") return;

  const DEFAULT_ENDPOINT = "";
  const ENDPOINT = window.JAKUB_ENV?.NEWSLETTER_ENDPOINT || DEFAULT_ENDPOINT;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const docReady = (fn) => {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  };

  const isValidEmail = (value) => EMAIL_RE.test(value.trim().toLowerCase());

  const setSubmitState = (root) => {
    const input = root.querySelector("[data-newsletter-email]");
    const button = root.querySelector("[data-newsletter-submit]");
    const loading = root.dataset.status === "loading";

    if (button) {
      button.disabled = loading || !input || !isValidEmail(input.value);
      button.textContent = loading ? "Sending…" : "I'm in";
    }
  };

  const setLoading = (root, loading) => {
    const input = root.querySelector("[data-newsletter-email]");
    if (loading) root.dataset.status = "loading";
    else if (root.dataset.status === "loading") root.dataset.status = "idle";
    if (input) input.disabled = loading;
    setSubmitState(root);
  };

  const setValidation = (root, show) => {
    const input = root.querySelector("[data-newsletter-email]");
    const validation = root.querySelector("[data-newsletter-validation]");
    if (input) {
      input.classList.toggle("is-invalid", show);
      input.setAttribute("aria-invalid", show ? "true" : "false");
    }
    if (validation) validation.hidden = !show;
  };

  const setNotice = (root, status, message) => {
    const notice = root.querySelector("[data-newsletter-notice]");
    root.dataset.status = status;
    if (!notice) return;
    notice.textContent = message || "";
    notice.hidden = !message;
  };

  const initNewsletterForm = (root) => {
    if (root.dataset.newsletterBound === "1") return;
    root.dataset.newsletterBound = "1";

    const form = root.querySelector("form");
    const input = root.querySelector("[data-newsletter-email]");
    if (!form || !input) return;

    let touched = false;

    setSubmitState(root);

    input.addEventListener("input", () => {
      const value = input.value.trim();
      if (touched) setValidation(root, value.length > 0 && !isValidEmail(value));
      if (root.dataset.status === "error") setNotice(root, "idle", "");
      setSubmitState(root);
    });

    input.addEventListener("blur", () => {
      touched = true;
      const value = input.value.trim();
      setValidation(root, value.length > 0 && !isValidEmail(value));
      setSubmitState(root);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      touched = true;

      const email = input.value.trim().toLowerCase();
      if (!isValidEmail(email)) {
        setValidation(root, true);
        setNotice(root, "idle", "");
        input.focus();
        return;
      }

      setValidation(root, false);
      setNotice(root, "idle", "");

      if (!ENDPOINT) {
        setNotice(root, "error", "Newsletter isn't wired up yet. Set PUBLIC_NEWSLETTER_ENDPOINT.");
        return;
      }

      setLoading(root, true);

      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          throw new Error("Newsletter API returned a non-JSON response");
        }

        const data = await response.json();
        const status = data.status || (response.ok ? "success" : "error");

        if (status === "success") {
          input.value = "";
          touched = false;
          setNotice(root, "success", data.message || "Got it. Talk soon.");
        } else if (status === "exists") {
          setNotice(root, "exists", data.message || "You're already on the list.");
        } else {
          setNotice(root, "error", data.message || "Hmm, that didn't work. Try again?");
        }
      } catch {
        setNotice(root, "error", "Hmm, something's off. Mind trying again?");
      } finally {
        setLoading(root, false);
      }
    });
  };

  docReady(() => {
    document.querySelectorAll("[data-newsletter-form]").forEach(initNewsletterForm);
  });
})();
