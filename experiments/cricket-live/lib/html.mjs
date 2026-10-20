// Commentary HTML from either source is reduced to b, i and br; everything else is
// text. Links are unwrapped to their label, existing entities are kept as written.

const ALLOWED_TAGS = /<(\/?)(b|i|br|strong|em)\s*\/?>/gi;
const LINKS = /<\/?a\b[^>]*>/gi;
// A private-use character marks kept tags while the rest of the text is escaped.
const MARK = String.fromCharCode(0xe000);
const MARKED = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

export function cleanHtml(text) {
  if (!text) return "";
  const kept = [];
  const marked = String(text)
    .replace(LINKS, "")
    .replace(ALLOWED_TAGS, (_, slash, tag) => {
      const lower = tag.toLowerCase();
      const t = lower === "strong" ? "b" : lower === "em" ? "i" : lower;
      kept.push(t === "br" ? "<br>" : `<${slash}${t}>`);
      return `${MARK}${kept.length - 1}${MARK}`;
    });
  const escaped = marked
    .replace(/&(?!#?\w+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\n/g, "<br>")
    .replace(/\n/g, "<br>");
  return balance(escaped.replace(MARKED, (_, n) => kept[Number(n)]));
}

// Drop unmatched closers and close any b/i left open, so one item can never restyle the next.
function balance(html) {
  const open = [];
  const out = html.replace(/<(\/?)(b|i)>/g, (tag, slash, name) => {
    if (!slash) {
      open.push(name);
      return tag;
    }
    const at = open.lastIndexOf(name);
    if (at < 0) return "";
    open.splice(at, 1);
    return tag;
  });
  return (
    out +
    open
      .reverse()
      .map((t) => `</${t}>`)
      .join("")
  );
}
