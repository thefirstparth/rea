// Layout and accessibility audit for one rendered Crease page, run inside the browser.
// It measures what a reader would see, not the markup: the boxes of every visible run
// of text and every icon, chip and image, then reports
//   overlap     two boxes drawn on top of each other (text under a chip, two labels)
//   overflow    the page, or a box, wider than the viewport (sideways scrolling)
//   clipped     an ellipsis cutting off a label
//   target      a control smaller than 24px (WCAG 2.2 AA) or 44px (Apple HIG)
//   contrast    text below WCAG AA contrast against what is painted under it
//   image       an image that failed to load
//   name        a control with no accessible name
// Boxes inside fixed or sticky chrome are compared only with each other, since page
// content is meant to scroll under them. Text boxes are trimmed to the glyphs (not
// the font's full ascent and descent) and to any ancestor that clips its overflow, so
// tight leading and ellipsised labels are not reported as collisions. A chip's
// die-cut ring (box-shadow spread) counts as part of the chip.
//
// Each check is a plain function; auditScript() joins them into one script for
// page.evaluate, so they run in the page without a bundler.

function isVisible(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (Number(cs.opacity) === 0) return false;
    if (n.tagName === "DETAILS" && !n.open && n !== el) {
      // Only the summary of a closed <details> renders.
      const summary = n.querySelector(":scope > summary");
      if (!summary || !summary.contains(el)) return false;
    }
  }
  return true;
}

function layerOf(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const p = getComputedStyle(n).position;
    if (p === "fixed" || p === "sticky") return n;
  }
  return document.documentElement;
}

function describe(el) {
  const cls = typeof el.className === "string" && el.className.trim();
  const text = (el.innerText || el.getAttribute("aria-label") || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 50);
  return `${el.tagName.toLowerCase()}${cls ? `.${cls.split(/\s+/).join(".")}` : ""}${text ? ` "${text}"` : ""}`;
}

// The part of a rect left visible by every ancestor that clips overflow.
function clipRect(el, r) {
  let { left, top, right, bottom } = r;
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    const c = n.getBoundingClientRect();
    left = Math.max(left, c.left);
    top = Math.max(top, c.top);
    right = Math.min(right, c.right);
    bottom = Math.min(bottom, c.bottom);
  }
  return right - left > 0.5 && bottom - top > 0.5
    ? { left, top, right, bottom, width: right - left, height: bottom - top }
    : null;
}

// Text runs (one box per line) and atomic visuals.
function collectBoxes() {
  const boxes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const el = t.parentElement;
    if (!t.nodeValue.trim() || !el || el.closest("svg,noscript,script,style"))
      continue;
    if (!isVisible(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    for (const raw of range.getClientRects()) {
      // Glyphs fill roughly the middle 70% of the font's content box.
      const inset = raw.height * 0.15;
      const r = clipRect(el, {
        left: raw.left,
        right: raw.right,
        top: raw.top + inset,
        bottom: raw.bottom - inset,
      });
      if (r) boxes.push({ el, node: t, r, kind: "text" });
    }
  }
  for (const el of document.body.querySelectorAll(
    "img,svg,.b,.stk,.flag,.cal",
  )) {
    if (el.parentElement?.closest("svg") || !isVisible(el)) continue;
    const ring = getComputedStyle(el).boxShadow.match(
      /0px 0px 0px (\d+(?:\.\d+)?)px/,
    );
    const g = ring ? Number(ring[1]) : 0;
    const raw = el.getBoundingClientRect();
    const r = clipRect(el.parentElement ?? el, {
      left: raw.left - g,
      top: raw.top - g,
      right: raw.right + g,
      bottom: raw.bottom + g,
    });
    if (r) boxes.push({ el, node: el, r, kind: "visual" });
  }
  return boxes.sort((a, b) => a.r.top - b.r.top);
}

// A visual and the text inside it (a chip's label) belong together; an element's own
// text and a child drawn over it do not.
function related(a, b) {
  return (
    a.node === b.node ||
    (a.kind === "visual" && a.node.contains(b.node)) ||
    (b.kind === "visual" && b.node.contains(a.node))
  );
}

function findOverlaps(boxes, out) {
  const seen = new Set();
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    const la = layerOf(a.el);
    for (let j = i + 1; j < boxes.length && boxes[j].r.top < a.r.bottom; j++) {
      const b = boxes[j];
      if (related(a, b) || la !== layerOf(b.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      // Text touching a chip or icon collides; two text runs may kiss at the edges.
      const tol = a.kind === "visual" || b.kind === "visual" ? 0 : 2;
      if (w <= tol || h <= 2) continue;
      const key = `${describe(a.el)}|${describe(b.el)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: "overlap",
        a: describe(a.el),
        b: describe(b.el),
        at: [
          Math.round(Math.max(a.r.left, b.r.left)),
          Math.round(Math.max(a.r.top, b.r.top) + scrollY),
        ],
      });
    }
  }
}

function insideScroller(el) {
  for (let n = el.parentElement; n; n = n.parentElement)
    if (
      ["auto", "scroll", "hidden", "clip"].includes(
        getComputedStyle(n).overflowX,
      )
    )
      return true;
  return false;
}

function findOverflow(boxes, out) {
  const vw = innerWidth;
  const sw = document.scrollingElement.scrollWidth;
  if (sw > vw + 1)
    out.push({
      kind: "overflow",
      a: "page",
      detail: `${sw}px wide in a ${vw}px viewport`,
    });
  for (const { el, r } of boxes)
    if ((r.right > vw + 1 || r.left < -1) && !insideScroller(el))
      out.push({
        kind: "overflow",
        a: describe(el),
        detail: `spans ${Math.round(r.left)}–${Math.round(r.right)}px`,
      });
}

function findClipped(out) {
  for (const el of document.body.querySelectorAll("*")) {
    if (getComputedStyle(el).textOverflow !== "ellipsis" || !isVisible(el))
      continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.innerText.trim())
      out.push({
        kind: "clipped",
        a: describe(el),
        detail: `${el.scrollWidth}px of text in ${el.clientWidth}px`,
      });
  }
}

function findControlIssues(out) {
  const controls = document.body.querySelectorAll(
    "a[href],button,summary,[role=button],input,select,textarea",
  );
  for (const el of controls) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // Links inside running text are exempt from target size (WCAG 2.5.8 inline
    // exception), as are inputs whose <label> is the target.
    const inline =
      el.tagName === "A" && getComputedStyle(el).display === "inline";
    const labelled = !!el.closest("label");
    const min = Math.min(r.width, r.height);
    const size = `${Math.round(r.width)}×${Math.round(r.height)}px`;
    if (!inline && !labelled && min < 24)
      out.push({
        kind: "target",
        severity: "fail",
        a: describe(el),
        detail: `${size}, under 24px`,
      });
    else if (!inline && !labelled && min < 44)
      out.push({
        kind: "target",
        severity: "warn",
        a: describe(el),
        detail: `${size}, under 44px`,
      });
    const name = (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.getAttribute("title") ||
      ""
    ).trim();
    if (!name && !labelled) out.push({ kind: "name", a: describe(el) });
  }
}

// Any CSS colour (rgb, oklab from color-mix, named) as sRGB, by painting it onto a
// one-pixel canvas.
function parseColor(s) {
  if (!s || s === "transparent") return null;
  const cache = (window.__auditColors ??= new Map());
  if (cache.has(s)) return cache.get(s);
  const ctx = (window.__auditCtx ??= Object.assign(
    document.createElement("canvas"),
    {
      width: 1,
      height: 1,
    },
  ).getContext("2d", { willReadFrequently: true }));
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillStyle = s;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const c = { r, g, b, a: a / 255 };
  cache.set(s, c);
  return c;
}

function luminance({ r, g, b }) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function blend(top, under) {
  return {
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  };
}

// What is painted under a point: the element stack there, top down, so a sibling
// drawn beneath the text (a tab highlight) counts. Null when the text is covered by
// something else (the floating tab bar) or sits on a gradient or image.
function backgroundAt(el, x, y) {
  const all = document.elementsFromPoint(x, y);
  if (
    !all.length ||
    !(all[0] === el || el.contains(all[0]) || all[0].contains(el))
  )
    return null;
  // Invisible layers (an opacity-0 highlight) paint nothing.
  const stack = all.filter(
    (n) => (!el.contains(n) || n === el) && isVisible(n),
  );
  const layers = [];
  for (const n of stack) {
    const cs = getComputedStyle(n);
    if (cs.backgroundImage !== "none" && n !== document.body) return null;
    const c = parseColor(cs.backgroundColor);
    if (c && c.a > 0) {
      layers.push(c);
      if (c.a >= 1) break;
    }
  }
  let bg = parseColor(getComputedStyle(document.body).backgroundColor);
  if (!bg || bg.a === 0) bg = { r: 255, g: 255, b: 255, a: 1 };
  for (const c of layers.reverse()) bg = blend(c, bg);
  return bg;
}

// Contrast for text on screen now (the runner scrolls through the page).
function findContrast(boxes, out) {
  const checked = new Set();
  for (const { el, kind, r } of boxes) {
    if (kind !== "text" || checked.has(el)) continue;
    const x = (r.left + r.right) / 2;
    const y = (r.top + r.bottom) / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    checked.add(el);
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    const bg = backgroundAt(el, x, y);
    if (!fg || !bg || fg.a === 0) continue;
    const [hi, lo] = [luminance(blend(fg, bg)), luminance(bg)].sort(
      (p, q) => q - p,
    );
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5))
      out.push({
        kind: "contrast",
        a: describe(el),
        detail: `${ratio.toFixed(2)}:1, needs ${large ? 3 : 4.5}:1`,
      });
  }
}

function findBrokenImages(out) {
  for (const img of document.images)
    if (isVisible(img) && img.complete && img.naturalWidth === 0)
      out.push({
        kind: "image",
        a: describe(img),
        detail: img.currentSrc || img.src,
      });
}

function runAudit(only) {
  const out = [];
  const boxes = collectBoxes();
  if (!only || only === "contrast") findContrast(boxes, out);
  if (!only) {
    findOverlaps(boxes, out);
    findOverflow(boxes, out);
    findClipped(out);
    findControlIssues(out);
    findBrokenImages(out);
  }
  return out;
}

const PARTS = [
  isVisible,
  layerOf,
  describe,
  clipRect,
  collectBoxes,
  related,
  findOverlaps,
  insideScroller,
  findOverflow,
  findClipped,
  findControlIssues,
  parseColor,
  luminance,
  blend,
  backgroundAt,
  findContrast,
  findBrokenImages,
  runAudit,
];

// A script for page.evaluate: every check, then a run. `only` limits it to one kind.
export function auditScript(only = null) {
  return `(() => {\n${PARTS.map(String).join("\n")}\nreturn runAudit(${JSON.stringify(only)});\n})()`;
}
