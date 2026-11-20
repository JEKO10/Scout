// Day 40.1 encrypted database backups (before production migrations).
//
//   create   one consistent snapshot of every table -> <dir>/scout-<stamp>.scoutbackup (+ .manifest.json)
//   verify   decrypts in memory, prints table row counts (and compares with the live database with --live)
//   restore  decrypts into a directory of CSV files, for a manual restore (plaintext: an explicit operator step)
//   seal     encrypts an existing directory of plaintext CSV backups (older backups); never deletes the originals
//   prune    lists encrypted backups past the retention; deletes them only with --confirm
//
// Keys and URLs come from the environment only (never from arguments, never
// printed): BACKUP_ENCRYPTION_KEY (32 bytes, base64; generate with
// `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
// and keep it in a password manager, NOT in the repository or next to the
// backups) and DATABASE_URL (the database to back up).
//
//   npx tsx scripts/ops/backup.ts create --dir "D:/secure/scout-backups"
//   npx tsx scripts/ops/backup.ts verify --file <file> [--live]
//   npx tsx scripts/ops/backup.ts restore --file <file> --out <dir>
//   npx tsx scripts/ops/backup.ts seal --in <plaintext dir> --out <file>
//   npx tsx scripts/ops/backup.ts prune --dir <dir> [--keep-days 30] [--confirm]
import "dotenv/config";

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  type BackupContents,
  backupKey,
  backupScript,
  backupsToPrune,
  countCsvRows,
  decryptBackup,
  encryptBackup,
  manifestFor,
  splitBackupOutput,
} from "../../lib/ops/backupFormat";

const PSQL = process.env.PSQL_PATH ?? "C:/Program Files/PostgreSQL/17/bin/psql.exe";
/** Encrypted backups are kept this long by default (the newest 3 always stay) */
const DEFAULT_KEEP_DAYS = 30;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  return url;
}

/** libpq settings from the URL, passed as environment variables: the password never shows in a process list */
function libpqEnv(): Record<string, string> {
  const url = new URL(databaseUrl());
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
  };
  const channelBinding = url.searchParams.get("channel_binding");
  if (channelBinding) env.PGCHANNELBINDING = channelBinding;
  return env;
}

function psql(args: string[], input?: string): string {
  const result = spawnSync(PSQL, ["-X", "-q", ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...libpqEnv() },
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`psql failed: ${(result.stderr || "").split("\n")[0].slice(0, 200)}`);
  return result.stdout;
}

function tables(): string[] {
  return psql(["-At", "-c", "select schemaname||'.'||tablename from pg_tables where schemaname in ('public','neon_auth','drizzle') order by 1"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function create() {
  const dir = arg("dir");
  if (!dir) throw new Error("--dir is required.");
  const key = backupKey(process.env.BACKUP_ENCRYPTION_KEY);
  const marker = `--scout-${randomUUID()}--`;
  const output = psql(["-f", "-"], backupScript(tables(), marker));
  const { snapshot, tables: data } = splitBackupOutput(output, marker);
  const contents: BackupContents = { version: 1, createdAt: new Date().toISOString(), snapshot, tables: data };
  const encrypted = encryptBackup(contents, key);
  mkdirSync(dir, { recursive: true });
  const name = `scout-${contents.createdAt.replace(/[-:]/g, "").slice(0, 13)}Z.scoutbackup`;
  writeFileSync(join(dir, name), encrypted, { mode: 0o600 });
  writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify(manifestFor(name, encrypted, contents), null, 2));
  console.log(`Encrypted backup: ${join(dir, name)} (${data.length} tables, ${data.reduce((sum, t) => sum + t.rows, 0)} rows)`);
}

function verify() {
  const file = arg("file");
  if (!file) throw new Error("--file is required.");
  const contents = decryptBackup(readFileSync(file), backupKey(process.env.BACKUP_ENCRYPTION_KEY));
  let mismatches = 0;
  for (const table of contents.tables) {
    let live = "";
    if (process.argv.includes("--live")) {
      const [schema, name] = table.name.split(".");
      const count = Number(psql(["-At", "-c", `select count(*) from "${schema}"."${name}"`]).trim());
      if (count !== table.rows) mismatches++;
      live = ` (live ${count})`;
    }
    console.log(`${table.name}: ${table.rows}${live}`);
  }
  console.log(`Backup of ${contents.createdAt}, snapshot ${contents.snapshot ?? "unknown"}: ${contents.tables.length} tables${process.argv.includes("--live") ? `, ${mismatches} mismatches` : ""}`);
}

function restore() {
  const file = arg("file");
  const out = arg("out");
  if (!file || !out) throw new Error("--file and --out are required.");
  const contents = decryptBackup(readFileSync(file), backupKey(process.env.BACKUP_ENCRYPTION_KEY));
  mkdirSync(out, { recursive: true });
  for (const table of contents.tables) writeFileSync(join(out, `${table.name}.csv`), table.csv, { mode: 0o600 });
  console.log(`Decrypted ${contents.tables.length} tables into ${out}. These files are plaintext: restore from them, then delete them.`);
}

function seal() {
  const input = arg("in");
  const out = arg("out");
  if (!input || !out) throw new Error("--in and --out are required.");
  const files = readdirSync(input).filter((f) => f.endsWith(".csv") && !f.startsWith("_"));
  const contents: BackupContents = {
    version: 1,
    createdAt: new Date().toISOString(),
    snapshot: `sealed from ${basename(input)}`,
    tables: files.map((f) => {
      const csv = readFileSync(join(input, f), "utf8");
      return { name: f.replace(/\.csv$/, ""), rows: countCsvRows(csv), csv };
    }),
  };
  const encrypted = encryptBackup(contents, backupKey(process.env.BACKUP_ENCRYPTION_KEY));
  writeFileSync(out, encrypted, { mode: 0o600 });
  writeFileSync(`${out}.manifest.json`, JSON.stringify(manifestFor(basename(out), encrypted, contents), null, 2));
  // Round trip before anyone deletes the originals
  decryptBackup(readFileSync(out), backupKey(process.env.BACKUP_ENCRYPTION_KEY));
  console.log(`Sealed ${files.length} tables into ${out} and verified it decrypts. The plaintext originals in ${input} were NOT deleted.`);
}

function prune() {
  const dir = arg("dir");
  if (!dir) throw new Error("--dir is required.");
  const keepDays = Number(arg("keep-days") ?? DEFAULT_KEEP_DAYS);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".scoutbackup"))
    .map((name) => {
      const manifest = JSON.parse(readFileSync(join(dir, `${name}.manifest.json`), "utf8")) as { createdAt: string };
      return { name, createdAt: new Date(manifest.createdAt) };
    });
  const old = backupsToPrune(files, new Date(), keepDays);
  if (!process.argv.includes("--confirm")) {
    console.log(old.length ? `Past ${keepDays} days (add --confirm to delete):\n${old.join("\n")}` : "Nothing past the retention.");
    return;
  }
  for (const name of old) {
    unlinkSync(join(dir, name));
    unlinkSync(join(dir, `${name}.manifest.json`));
  }
  console.log(`Deleted ${old.length} backups past ${keepDays} days.`);
}

const commands: Record<string, () => void> = { create, verify, restore, seal, prune };
try {
  const command = commands[process.argv[2] ?? ""];
  if (!command) throw new Error(`Commands: ${Object.keys(commands).join(", ")}`);
  command();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
