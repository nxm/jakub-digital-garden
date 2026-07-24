// jakub.app — note graph. Force-directed canvas view of the note network.
// #graph        → the full global graph (the /Graph page)
// #graph-rail   → a local graph (current note + its direct connections), shown
//                 in the right rail on every content page.
(() => {
  if (typeof window === "undefined") return;

  const css = getComputedStyle(document.documentElement);
  const V = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
  const COL = {
    fg: V("--fg-strong", "#0a0a0a"),
    muted: V("--fg-muted", "#615d59"),
    faint: V("--fg-faint", "#a39e98"),
    border: V("--border", "#e6e6e6"),
    accent: V("--accent", "#0075de"),
    surface: V("--surface", "#ffffff"),
  };
  const PALETTE = [
    V("--sticker-sky", "#62aef0"),
    V("--sticker-pink", "#ff64c8"),
    V("--sticker-orange", "#dd5b00"),
    V("--sticker-teal", "#2a9d99"),
    V("--sticker-green", "#1aae39"),
    V("--sticker-purple", "#d6b6f6"),
  ];
  const groupColor = new Map();
  const colorFor = (g) => {
    if (!groupColor.has(g)) groupColor.set(g, PALETTE[groupColor.size % PALETTE.length]);
    return groupColor.get(g);
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function initGraph(el, localSlug) {
    if (getComputedStyle(el).display === "none") return; // e.g. rail hidden on the /Graph page

    const canvas = document.createElement("canvas");
    el.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    let nodes = [];
    let edges = [];
    const byId = new Map();
    const neighbors = new Map();
    const currentId = localSlug || null;
    let hover = null;
    let dragging = null;
    let view = { s: 1, tx: 0, ty: 0 };
    let alpha = 1;
    let running = false;
    const pointer = { moved: false };

    const REPULSION = 2600, SPRING = 0.02, GRAVITY = 0.015, DAMP = 0.86;

    const empty = (msg) => {
      el.innerHTML = `<p class="note-graph__empty">${msg || "No connections yet."}</p>`;
    };

    fetch("/graph.json")
      .then((r) => r.json())
      .then((raw) => {
        let data = raw;
        if (localSlug) {
          const keep = new Set([localSlug]);
          for (const e of raw.edges) {
            if (e.source === localSlug) keep.add(e.target);
            if (e.target === localSlug) keep.add(e.source);
          }
          data = {
            nodes: raw.nodes.filter((n) => keep.has(n.id)),
            edges: raw.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
          };
          if (data.nodes.length <= 1) { empty(); return; }
        }
        build(data);
        resize();
        if (reduced) { for (let i = 0; i < 300; i++) step(1); draw(); }
        else { running = true; requestAnimationFrame(loop); }
      })
      .catch(() => empty("Graph unavailable."));

    function build(data) {
      const n = data.nodes.length || 1;
      nodes = data.nodes.map((d, i) => {
        const a = (i / n) * Math.PI * 2;
        const jitter = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
        const r = (localSlug ? 90 : 150) + jitter * 30;
        return { ...d, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, deg: 0 };
      });
      for (const node of nodes) { byId.set(node.id, node); neighbors.set(node.id, new Set()); }
      edges = data.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
      for (const e of edges) {
        byId.get(e.source).deg++; byId.get(e.target).deg++;
        neighbors.get(e.source).add(e.target); neighbors.get(e.target).add(e.source);
      }
    }

    function step(scale) {
      const a = reduced ? 1 : alpha;
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const q = nodes[j];
          let dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = (i - j) || 1; dy = 1; d2 = 2; }
          const f = (REPULSION / d2) * a, d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
        }
      }
      for (const e of edges) {
        const p = byId.get(e.source), q = byId.get(e.target);
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const len = e.kind === "tree" ? 70 : 95;
        const f = (d - len) * SPRING * a;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
      }
      for (const p of nodes) {
        p.vx -= p.x * GRAVITY * a; p.vy -= p.y * GRAVITY * a;
        if (p === dragging) { p.vx = 0; p.vy = 0; continue; }
        p.vx *= DAMP; p.vy *= DAMP;
        p.x += p.vx * scale; p.y += p.vy * scale;
      }
      if (!reduced) alpha = Math.max(0.03, alpha * 0.985);
    }

    function fit() {
      if (!nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of nodes) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const w = canvas.clientWidth, h = canvas.clientHeight, pad = localSlug ? 42 : 60;
      const gw = Math.max(maxX - minX, 1), gh = Math.max(maxY - minY, 1);
      const s = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh, localSlug ? 1.6 : 2.2);
      view = { s, tx: w / 2 - ((minX + maxX) / 2) * s, ty: h / 2 - ((minY + maxY) / 2) * s };
    }
    const toScreen = (p) => ({ x: p.x * view.s + view.tx, y: p.y * view.s + view.ty });
    const toWorld = (x, y) => ({ x: (x - view.tx) / view.s, y: (y - view.ty) / view.s });
    const radius = (p) => (p.id === currentId ? 6.5 : 3.5 + Math.min(p.deg, 7) * 1.3);

    function draw() {
      fit();
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const active = hover ? neighbors.get(hover.id) : null;
      const dim = !!hover;

      for (const e of edges) {
        const p = toScreen(byId.get(e.source)), q = toScreen(byId.get(e.target));
        const on = hover && (e.source === hover.id || e.target === hover.id);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
        ctx.strokeStyle = on ? COL.accent : e.kind === "tree" ? COL.border : COL.faint;
        ctx.globalAlpha = on ? 0.9 : dim ? 0.12 : e.kind === "tree" ? 0.5 : 0.4;
        ctx.lineWidth = on ? 1.5 : 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      ctx.font = '500 12px "Inter", system-ui, sans-serif';
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const showAll = nodes.length <= 28;
      for (const p of nodes) {
        const s = toScreen(p), r = radius(p);
        const isHover = hover === p, isCur = p.id === currentId;
        const isNbr = active && active.has(p.id);
        const faded = dim && !isHover && !isNbr;
        ctx.globalAlpha = faded ? 0.28 : 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, isHover ? r + 1.5 : r, 0, Math.PI * 2);
        ctx.fillStyle = colorFor(p.group);
        ctx.fill();
        if (isHover || isCur) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = isCur ? COL.fg : COL.surface;
          ctx.stroke();
        }
        if (showAll || isHover || isNbr || isCur) {
          ctx.fillStyle = isHover || isCur ? COL.fg : COL.muted;
          ctx.globalAlpha = faded ? 0.28 : isHover || isCur ? 1 : 0.85;
          ctx.fillText(p.title, s.x, s.y + r + 4);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Run the simulation only while it's still moving or the user is interacting,
    // then stop — no perpetual repaint eating CPU on every page.
    function loop() {
      step(1); draw();
      if (!reduced && alpha <= 0.031 && !dragging && hover === null) { running = false; return; }
      requestAnimationFrame(loop);
    }
    function kick() {
      if (reduced) { draw(); return; }
      alpha = Math.max(alpha, 0.4);
      if (!running) { running = true; requestAnimationFrame(loop); }
    }

    function pick(x, y) {
      let best = null, bd = 18 * 18;
      for (const p of nodes) {
        const s = toScreen(p), dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }
    const localXY = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    canvas.addEventListener("pointermove", (ev) => {
      const { x, y } = localXY(ev);
      pointer.moved = true;
      if (dragging) { const w = toWorld(x, y); dragging.x = w.x; dragging.y = w.y; kick(); return; }
      const hit = pick(x, y);
      if (hit !== hover) { hover = hit; canvas.style.cursor = hit ? "pointer" : "default"; if (!running) draw(); }
    });
    canvas.addEventListener("pointerdown", (ev) => {
      const { x, y } = localXY(ev);
      pointer.moved = false;
      dragging = pick(x, y);
      if (dragging) { canvas.setPointerCapture(ev.pointerId); kick(); }
    });
    canvas.addEventListener("pointerup", (ev) => {
      const { x, y } = localXY(ev);
      const hit = pick(x, y);
      if (hit && !pointer.moved) window.location.href = hit.href;
      dragging = null;
    });
    canvas.addEventListener("pointerleave", () => { hover = null; if (!running) draw(); });

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      if (reduced || !running) draw();
    }
    // Re-fit when the container resizes — window resize AND rail drag both count.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(resize).observe(el);
    } else {
      window.addEventListener("resize", resize);
    }
  }

  const full = document.getElementById("graph");
  if (full) initGraph(full, null);
  const rail = document.getElementById("graph-rail");
  if (rail) initGraph(rail, rail.dataset.slug || null);
})();
