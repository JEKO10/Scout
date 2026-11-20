// Day 40.1 encrypted database backups (before production migrations).
//
//   create   one consistent snapshot of every table -> <dir>/scout-<stamp>.scoutbackup (+ .manifest.json)
//   verify   decrypts in memory, prints table row counts (and compares with the live database with --live)
//   restore  decrypts into a directory of CSV files (plaintext: needs --plaintext, never inside the repository)
//   load     loads such a directory into an EMPTY, freshly migrated database (refuses one holding data), then compares counts
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
//   npx tsx scripts/ops/backup.ts restore --file <file> --out <dir> --plaintext
//   npx tsx scripts/ops/backup.ts load --dir <dir>            (DATABASE_URL = the empty target)
//   npx tsx scripts/ops/backup.ts seal --in <plaintext dir> --out <file>
//   npx tsx scripts/ops/backup.ts prune --dir <dir> [--keep-days 30] [--confirm]
import "dotenv/config";

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  type BackupContents,
  backupKey,
  backupScript,
  backupsToPrune,
  countCsvRows,
  decryptBackup,
  encryptBackup,
  isInside,
  loadOrder,
  manifestFor,
  splitBackupOutput,
} from "../../lib/ops/backupFormat";

/** The repository: never a place for backups or plaintext exports */
const REPO = resolve(__dirname, "..", "..");
const key = () => backupKey(process.env.BACKUP_ENCRYPTION_KEY, process.env.TOKEN_ENCRYPTION_KEY);

/** Written next to the target, verified, then moved into place: a crash never leaves a half file that looks complete */
function writeVerified(path: string, encrypted: Buffer) {
  const temp = `${path}.partial`;
  writeFileSync(temp, encrypted, { mode: 0o600 });
  decryptBackup(readFileSync(temp), key());
  renameSync(temp, path);
}

function refuseRepo(path: string, what: string) {
  if (isInside(path, REPO)) throw new Error(`${what} must be outside the repository (${REPO}).`);
}

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
  refuseRepo(dir, "--dir");
  const backupKeyBytes = key();
  const marker = `--scout-${randomUUID()}--`;
  const output = psql(["-f", "-"], backupScript(tables(), marker));
  const { snapshot, tables: data } = splitBackupOutput(output, marker);
  const contents: BackupContents = { version: 1, createdAt: new Date().toISOString(), snapshot, tables: data };
  const encrypted = encryptBackup(contents, backupKeyBytes);
  mkdirSync(dir, { recursive: true });
  const name = `scout-${contents.createdAt.replace(/[-:]/g, "").slice(0, 13)}Z.scoutbackup`;
  writeVerified(join(dir, name), encrypted);
  writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify(manifestFor(name, encrypted, contents, backupKeyBytes), null, 2));
  console.log(`Encrypted backup: ${join(dir, name)} (${data.length} tables, ${data.reduce((sum, t) => sum + t.rows, 0)} rows)`);
}

function verify() {
  const file = arg("file");
  if (!file) throw new Error("--file is required.");
  const contents = decryptBackup(readFileSync(file), key());
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
  // Writing personal data in plaintext is a deliberate step, never a default
  if (!process.argv.includes("--plaintext")) throw new Error("restore writes plaintext CSV files: add --plaintext to confirm.");
  refuseRepo(out, "--out");
  const contents = decryptBackup(readFileSync(file), key());
  mkdirSync(out, { recursive: true });
  for (const table of contents.tables) writeFileSync(join(out, `${table.name}.csv`), table.csv, { mode: 0o600 });
  console.log(
    `Decrypted ${contents.tables.length} tables into ${out}. To restore: migrate an EMPTY database with drizzle-kit, then run "load --dir" against it. These files are plaintext: delete them when done.`,
  );
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
  refuseRepo(out, "--out");
  const sealKey = key();
  const encrypted = encryptBackup(contents, sealKey);
  // Verified before it's in place: only then may anyone delete the originals
  writeVerified(out, encrypted);
  writeFileSync(`${out}.manifest.json`, JSON.stringify(manifestFor(basename(out), encrypted, contents, sealKey), null, 2));
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

/**
 * Loads a restored folder into the database in DATABASE_URL, which must be
 * EMPTY (just migrated): a database that holds any data is refused, so this
 * can't overwrite production. Tables load parents first; tables the target
 * doesn't have (neon_auth, managed by Neon Auth) are skipped and listed.
 * Every table's row count is compared afterwards.
 */
function load() {
  const dir = arg("dir");
  if (!dir) throw new Error("--dir is required (a folder made by restore).");
  const quoted = (t: string) => `"${t.split(".")[0]}"."${t.split(".")[1]}"`;
  const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  const existing = new Set(lines(psql(["-At", "-c", "select schemaname||'.'||tablename from pg_tables where schemaname in ('public','neon_auth')"])));
  const wanted = files.map((f) => f.replace(/\.csv$/, "")).filter((t) => !t.startsWith("drizzle."));
  const skipped = wanted.filter((t) => !existing.has(t));
  const tablesToLoad = wanted.filter((t) => existing.has(t));
  const rowsInTarget = tablesToLoad.length
    ? lines(psql(["-At", "-c", `${tablesToLoad.map((t) => `select count(*) from ${quoted(t)}`).join(" union all ")};`])).reduce((sum, n) => sum + Number(n), 0)
    : 0;
  if (rowsInTarget > 0) throw new Error(`The target database isn't empty (${rowsInTarget} rows). load only fills a freshly migrated, empty database.`);
  const edges = lines(
    psql([
      "-At",
      "-F",
      "|",
      "-c",
      "select n1.nspname||'.'||c1.relname, n2.nspname||'.'||c2.relname from pg_constraint k join pg_class c1 on c1.oid=k.conrelid join pg_namespace n1 on n1.oid=c1.relnamespace join pg_class c2 on c2.oid=k.confrelid join pg_namespace n2 on n2.oid=c2.relnamespace where k.contype='f'",
    ]),
  ).map((line) => {
    const [child, parent] = line.split("|");
    return { child, parent };
  });
  const order = loadOrder(tablesToLoad, edges);
  const copyPath = (t: string) => resolve(dir, `${t}.csv`).split("\\").join("/");
  const script = ["\\set ON_ERROR_STOP on", "begin;", ...order.map((t) => `\\copy ${quoted(t)} from '${copyPath(t)}' csv header`), "commit;"].join("\n");
  psql(["-f", "-"], `${script}\n`);
  let mismatches = 0;
  for (const t of order) {
    const expected = countCsvRows(readFileSync(join(dir, `${t}.csv`), "utf8"));
    const actual = Number(psql(["-At", "-c", `select count(*) from ${quoted(t)}`]).trim());
    if (expected !== actual) {
      mismatches++;
      console.log(`MISMATCH ${t}: backup ${expected}, loaded ${actual}`);
    }
  }
  console.log(`Loaded ${order.length} tables, ${mismatches} mismatches.${skipped.length ? ` Skipped (not in this database): ${skipped.join(", ")}` : ""}`);
}

const commands: Record<string, () => void> = { create, verify, restore, seal, prune, load };
try {
  const command = commands[process.argv[2] ?? ""];
  if (!command) throw new Error(`Commands: ${Object.keys(commands).join(", ")}`);
  command();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
