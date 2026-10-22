const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return safeChar(parseInt(code.slice(2), 16)) ?? match;
    if (code.startsWith('#')) return safeChar(parseInt(code.slice(1), 10)) ?? match;
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function safeChar(code: number): string | null {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
}

/**
 * Readable text from an HTML page for the analyser: scripts, styles and markup removed, block elements
 * kept as line breaks. Not a sanitiser; the result only ever goes to the model as untrusted data.
 */
export function htmlToText(html: string, maxChars: number): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre|\/section|\/article|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[\n ]*/g, '\n')
    .trim()
    .slice(0, maxChars);
}
