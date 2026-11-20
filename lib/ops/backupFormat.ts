// Day 40.1 encrypted database backups: the file format. Pure (no I/O), so it
// is tested directly. A backup is the CSV of every table from one database
// snapshot, packed as JSON, gzip-compressed and encrypted with AES-256-GCM.
// The plaintext never touches the disk: psql streams into memory, and only
// the encrypted file is written.
//
// File layout: "SCOUTBK1" | 12-byte IV | 16-byte auth tag | ciphertext.
// The key is 32 random bytes, base64, from BACKUP_ENCRYPTION_KEY: never the
// app's TOKEN_ENCRYPTION_KEY, never stored next to the backups or in Git.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = Buffer.from("SCOUTBK1");

export type BackupTable = { name: string; rows: number; csv: string };
export type BackupContents = { version: 1; createdAt: string; snapshot: string | null; tables: BackupTable[] };

/** The non-secret summary written next to a backup: names and counts, never data */
export type BackupManifest = { file: string; createdAt: string; sha256: string; tables: { name: string; rows: number }[] };

export function backupKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("BACKUP_ENCRYPTION_KEY is not set.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return key;
}

/** Rows in a CSV with a header line (quoted newlines inside values are respected) */
export function countCsvRows(csv: string): number {
  let rows = 0;
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') quoted = !quoted;
    else if (c === "\n" && !quoted) rows++;
  }
  if (csv.length && !csv.endsWith("\n")) rows++;
  return Math.max(0, rows - 1);
}

/**
 * The psql script: one REPEATABLE READ, read-only transaction, each table
 * copied to stdout after a marker line (random per run, so data can't fake it).
 */
export function backupScript(tables: string[], marker: string): string {
  const lines = ["\\set ON_ERROR_STOP on", "begin transaction isolation level repeatable read read only;", `\\echo ${marker} __snapshot__`, "select now();"];
  for (const table of tables) {
    const [schema, name] = table.split(".");
    if (!schema || !name || !/^[a-z_][a-z0-9_]*$/i.test(schema) || !/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unexpected table name: ${table}`);
    lines.push(`\\echo ${marker} ${table}`, `\\copy (select * from "${schema}"."${name}") to stdout csv header`);
  }
  lines.push("commit;");
  return `${lines.join("\n")}\n`;
}

/** Splits psql's stdout back into tables (and the snapshot time) */
export function splitBackupOutput(output: string, marker: string): { snapshot: string | null; tables: BackupTable[] } {
  const parts = output.split(new RegExp(`^${marker} `, "m")).slice(1);
  let snapshot: string | null = null;
  const tables: BackupTable[] = [];
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const name = part.slice(0, newline).trim();
    const body = part.slice(newline + 1);
    if (name === "__snapshot__") {
      snapshot = body.split("\n").find((line) => /\d{4}-\d{2}-\d{2}/.test(line))?.trim() ?? null;
      continue;
    }
    // psql prints "COMMIT" after the last table
    const csv = body.replace(/\nCOMMIT\n?$/, "\n").replace(/^COMMIT\n?$/, "");
    tables.push({ name, rows: countCsvRows(csv), csv });
  }
  return { snapshot, tables };
}

export function encryptBackup(contents: BackupContents, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(contents), "utf8"))), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

/** Throws on a wrong key, a damaged or tampered file */
export function decryptBackup(file: Buffer, key: Buffer): BackupContents {
  if (file.length < MAGIC.length + 28 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a Scout backup file.");
  const iv = file.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = file.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(file.subarray(MAGIC.length + 28)), decipher.final()]);
  const contents = JSON.parse(gunzipSync(plain).toString("utf8")) as BackupContents;
  if (contents.version !== 1 || !Array.isArray(contents.tables)) throw new Error("Unsupported backup version.");
  return contents;
}

export function manifestFor(file: string, encrypted: Buffer, contents: BackupContents): BackupManifest {
  return {
    file,
    createdAt: contents.createdAt,
    sha256: createHash("sha256").update(encrypted).digest("hex"),
    tables: contents.tables.map(({ name, rows }) => ({ name, rows })),
  };
}

/** Backups older than the retention, newest kept regardless (never deletes the last ones) */
export function backupsToPrune(files: { name: string; createdAt: Date }[], now: Date, keepDays: number, keepAtLeast = 3): string[] {
  const sorted = [...files].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return sorted.slice(keepAtLeast).filter((f) => now.getTime() - f.createdAt.getTime() > keepDays * 86_400_000).map((f) => f.name);
}
