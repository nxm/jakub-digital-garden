// jakub.app — site enhancements
// - Lightbox: click any content image to view it full-screen.
// - Sidebar drawer: toggle the section nav on narrow viewports.
(() => {
  if (typeof window === "undefined") return;
  const docReady = (fn) => {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  };

  // ---------- Lightbox ----------
  const initLightbox = () => {
    const lb = document.createElement("div");
    lb.className = "lightbox";
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.setAttribute("aria-hidden", "true");
    lb.innerHTML = `
      <button class="lightbox-close" type="button" aria-label="Close (Esc)">×</button>
      <figure class="lightbox-figure">
        <img class="lightbox-image" alt="">
        <figcaption class="lightbox-caption" hidden></figcaption>
      </figure>
    `;
    document.body.appendChild(lb);
    const img = lb.querySelector(".lightbox-image");
    const caption = lb.querySelector(".lightbox-caption");

    const close = () => {
      lb.classList.remove("open");
      lb.setAttribute("aria-hidden", "true");
      document.body.classList.remove("no-scroll");
    };
    const open = (src, alt) => {
      img.src = src;
      img.alt = alt || "";
      if (alt) {
        caption.textContent = alt;
        caption.hidden = false;
      } else {
        caption.hidden = true;
      }
      lb.classList.add("open");
      lb.setAttribute("aria-hidden", "false");
      document.body.classList.add("no-scroll");
    };

    lb.addEventListener("click", (e) => {
      if (e.target === lb || e.target.closest(".lightbox-close")) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && lb.classList.contains("open")) close();
    });

    const wireImage = (el) => {
      if (el.dataset.lightboxBound === "1") return;
      // Skip if image is wrapped in a link, marked no-lightbox, or inline avatar size.
      if (el.closest("a[href]")) return;
      if (el.classList.contains("no-lightbox")) return;
      const inlineMax = (el.getAttribute("style") || "").match(/max-width:\s*(\d+)px/i);
      if (inlineMax && Number(inlineMax[1]) <= 140) return;
      el.dataset.lightboxBound = "1";
      el.style.cursor = "zoom-in";
      el.addEventListener("click", () => open(el.currentSrc || el.src, el.alt));
    };

    document.querySelectorAll("main img").forEach(wireImage);
  };

  // ---------- Sidebar drawer (mobile) ----------
  const initDrawer = () => {
    const toggle = document.querySelector("[data-nav-toggle]");
    const sidebar = document.querySelector(".sidebar");
    if (!toggle || !sidebar) return;

    const setOpen = (open) => {
      document.body.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };

    toggle.addEventListener("click", () => {
      setOpen(!document.body.classList.contains("nav-open"));
    });
    const scrim = document.querySelector("[data-nav-scrim]");
    if (scrim) scrim.addEventListener("click", () => setOpen(false));
    // Close after following a link inside the drawer.
    sidebar.addEventListener("click", (e) => {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
  };

  // ---------- Resizable graph rail ----------
  const initRailResize = () => {
    const handle = document.querySelector("[data-rail-handle]");
    if (!handle) return;
    const root = document.documentElement;
    const MIN = 220, MAX = 560, KEY = "jakub.railWidth";

    const apply = (px) => {
      const c = Math.max(MIN, Math.min(MAX, px));
      root.style.setProperty("--rail-width", `${c}px`);
      return c;
    };
    const save = (px) => { try { localStorage.setItem(KEY, String(Math.round(px))); } catch {} };
    const current = () =>
      parseFloat(getComputedStyle(root).getPropertyValue("--rail-width")) || 320;

    let dragging = false;
    const onMove = (e) => { if (dragging) apply(window.innerWidth - e.clientX); };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("rail-resizing");
      save(current());
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragging = true;
      document.body.classList.add("rail-resizing");
    });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    handle.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); save(apply(current() + 20)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); save(apply(current() - 20)); }
    });
  };

  docReady(() => {
    initLightbox();
    initDrawer();
    initRailResize();
  });
})();
