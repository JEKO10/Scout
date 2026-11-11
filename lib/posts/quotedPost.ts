// A quote's own text and the post it quotes travel as one content string, so
// the feed shows both without new columns. The AI prompts split it again:
// they must never confuse the quoting author's words with the quoted ones.

const MARKER = "\n\n[Quoted post] ";

export function withQuotedPost(own: string, quoted: string): string {
  return `${own}${MARKER}${quoted}`;
}

/** The author's own words, and the quoted post's text when there is one. */
export function splitQuotedPost(content: string): { own: string; quoted: string | null } {
  const at = content.indexOf(MARKER);
  if (at === -1) return { own: content, quoted: null };
  return { own: content.slice(0, at), quoted: content.slice(at + MARKER.length) };
}
