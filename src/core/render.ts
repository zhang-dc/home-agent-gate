/**
 * Rendering for chat platforms that display plain text (WeChat does not
 * render Markdown). Strips common Markdown syntax and splits long replies
 * into platform-sized chunks on paragraph boundaries.
 */

export function markdownToPlainText(md: string): string {
  let text = md;
  // Fenced code blocks: keep the code, drop the fences.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => code.trimEnd());
  // Headings -> 【heading】
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "【$1】");
  // Bold / italic / inline code markers.
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(?<![\w`])\*([^*\n]+)\*(?![\w`])/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Links: [text](url) -> text (url); bare image links -> url.
  text = text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // Bullets and horizontal rules.
  // [ \t] rather than \s: with /m, \s* would swallow the blank line before a list.
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "————");
  // Blockquotes.
  text = text.replace(/^>\s?/gm, "");
  // Collapse 3+ blank lines.
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Split text into chunks of at most maxChars, preferring paragraph breaks. */
export function chunkText(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = window.lastIndexOf("\n\n");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf("\n");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf("。");
    if (cut < maxChars * 0.4) cut = maxChars;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
