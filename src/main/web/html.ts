const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•",
  copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function stripTags(value: string): string {
  const text = decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  // Inline tags split a sentence; closing punctuation must stay attached.
  return text.replace(/\s+([.,;:!?%)\]])/g, "$1").replace(/([(\[])\s+/g, "$1");
}

export function extractTitle(html: string): string {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!raw) {
    const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
    return og ? decodeEntities(og).trim() : "";
  }
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/**
 * Converts HTML into readable text with Markdown-ish structure. The converter is
 * intentionally lossy: it exists to feed a model and a human preview pane, not to
 * re-serialize a document. Regex parsing avoids shipping a DOM implementation in
 * the main process, where a parser dependency would outweigh the accuracy gain.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|head|object|canvas)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, inner: string) => {
      const label = stripTags(inner) || href;
      const target = resolveUrl(href, baseUrl);
      if (!target || target.startsWith("javascript:") || target.startsWith("#")) return ` ${label} `;
      return ` [${label}](${target}) `;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `\n\n${"#".repeat(Math.min(Number(level) || 1, 6))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(p|div|section|article|header|footer|main|aside|nav|tr|blockquote|pre|table|ul|ol|dl|dt|dd|figure|figcaption|form|fieldset)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|tr|blockquote|pre|table|ul|ol|dl|dt|dd|h[1-6])>/gi, "\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");

  body = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return body;
}

function resolveUrl(href: string, baseUrl?: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  try {
    return baseUrl ? new URL(trimmed, baseUrl).toString() : new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}
