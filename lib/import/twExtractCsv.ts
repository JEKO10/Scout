import type { NormalizedCandidatePost, PostKind } from "@/lib/posts/types";

// Parses CSV exports in the TwExtract format (one row per post) into
// source-agnostic candidate posts. Pure: no I/O, easy to test.

/** RFC 4180: quoted fields, "" escapes, newlines inside quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...data] = rows.filter((r) => r.length > 1);
  if (!header) return [];
  return data.map((r) =>
    Object.fromEntries(header.map((name, i) => [name.trim(), r[i] ?? ""])),
  );
}

const KINDS: Record<string, PostKind> = {
  Tweet: "post",
  Reply: "reply",
  Quoted: "quote",
  Retweet: "repost",
};

// Exports escape these HTML entities in post text
const decodeEntities = (text: string) =>
  text.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

const count = (value: string | undefined) => Number(value) || 0;

export const REQUIRED_COLUMNS = ["ID", "Text", "Author Username", "Created At"];

export function parseTwExtractCsv(text: string): NormalizedCandidatePost[] {
  // Strip the UTF-8 BOM, otherwise the first header reads "﻿ID"
  const records = parseCsv(text.replace(/^﻿/, ""));
  const missing = REQUIRED_COLUMNS.filter((column) => !(column in (records[0] ?? {})));
  if (records.length > 0 && missing.length > 0) {
    throw new Error(`Missing columns: ${missing.join(", ")}`);
  }

  return records
    .filter((record) => record.ID && record["Author Username"] && record["Created At"])
    .map((record) => {
      const handle = record["Author Username"].replace(/^@/, "");
      const postedAt = new Date(`${record["Created At"].replace(" ", "T")}Z`);

      return {
        platform: "x" as const,
        platformPostId: record.ID,
        authorPlatformUserId: null,
        authorHandle: handle,
        content: decodeEntities(record.Text ?? ""),
        url: record["Tweet URL"] || `https://x.com/${handle}/status/${record.ID}`,
        postedAt,
        kind: KINDS[record.Type] ?? "post",
        metrics: {
          likes: count(record["Favorite Count"]),
          replies: count(record["Reply Count"]),
          reposts: count(record["Retweet Count"]) + count(record["Quote Count"]),
          impressions: count(record["View Count"]),
        },
      };
    })
    .filter((post) => !Number.isNaN(post.postedAt.getTime()));
}
