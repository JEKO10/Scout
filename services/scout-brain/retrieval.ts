import type { Post } from "@/db/schema";

// v0 retrieval: shared keywords, no embeddings or vector DB yet.

const STOPWORDS = new Set(
  "about after again also among been before being between both could does doing during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while with would your".split(
    " ",
  ),
);

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
  );
}

/**
 * The user's own posts most related to `text`, by shared keywords, as voice
 * examples. Falls back to the best-performing posts when nothing overlaps.
 */
export function pickRelevantPosts(
  posts: Post[],
  text: string,
  count = 4,
): Post[] {
  const target = keywords(text);

  return posts
    .map((post) => {
      let overlap = 0;
      for (const word of keywords(post.content)) if (target.has(word)) overlap++;
      return { post, overlap, likes: post.metrics?.likes ?? 0 };
    })
    .sort((a, b) => b.overlap - a.overlap || b.likes - a.likes)
    .slice(0, count)
    .map(({ post }) => post);
}

/**
 * Items whose text shares at least `minOverlap` keywords with `text`, most
 * overlap first. Unlike pickRelevantPosts there is no fallback: unrelated
 * items are left out rather than padded in.
 */
export function pickRelated<T>(
  items: T[],
  getText: (item: T) => string,
  text: string,
  { count, minOverlap = 2 }: { count: number; minOverlap?: number },
): T[] {
  const target = keywords(text);
  return items
    .map((item) => {
      let overlap = 0;
      for (const word of keywords(getText(item))) if (target.has(word)) overlap++;
      return { item, overlap };
    })
    .filter(({ overlap }) => overlap >= minOverlap)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, count)
    .map(({ item }) => item);
}
