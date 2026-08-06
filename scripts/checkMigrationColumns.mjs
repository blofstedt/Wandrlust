/**
 * Check that every column a migration references actually exists.
 *
 *   npm run check:sql
 *
 * WHY
 *
 * A function body in Postgres is not validated against the schema when you
 * create it — `language sql` bodies are parsed, but a typo'd column in a
 * migration is only found when you RUN the migration, and a migration that
 * fails halfway is a bad afternoon on a production database.
 *
 * This reads the table definitions out of the committed schema files, then
 * reads the aliased column references out of each migration, and reports
 * anything that does not line up. It is the same failure this repo already
 * guards against upstream with `npm run probe` — a name that looks right,
 * isn't, and doesn't announce itself — just at the database end.
 *
 * It is a static check, not a substitute for running the migration. It cannot
 * see a live database, so it will not catch a column that exists in these
 * files but was never applied to the real project.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Postgres identifiers are case-insensitive unless quoted; we lower-case. */
const norm = (s) => s.trim().toLowerCase();

/**
 * Build { tableName -> Set(columns) } from every schema and migration file.
 *
 * Handles both `create table` bodies and the `alter table ... add column`
 * form that later migrations use, since several columns this project relies
 * on (edge_accuracy, camping_basis_kind) arrive that way in 03.
 */
const readSchema = (files) => {
  const tables = new Map();
  const add = (table, column) => {
    const key = norm(table).replace(/^public\./, '');
    if (!tables.has(key)) tables.set(key, new Set());
    tables.get(key).add(norm(column));
  };

  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');

    // create table public.foo ( ... );
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)\s*\(([\s\S]*?)\n\s*\);/gi;
    for (const m of sql.matchAll(createRe)) {
      const [, table, body] = m;
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        // Skip comments and table-level constraints.
        if (!line || line.startsWith('--')) continue;
        if (/^(constraint|primary\s+key|unique|foreign\s+key|check|exclude)\b/i.test(line)) continue;
        const col = line.match(/^"?([a-z_][a-z0-9_]*)"?\s+/i);
        if (col) add(table, col[1]);
      }
    }

    // alter table public.foo add column [if not exists] bar type
    const alterRe =
      /alter\s+table\s+(?:only\s+)?([\w.]+)([\s\S]*?);/gi;
    for (const m of sql.matchAll(alterRe)) {
      const [, table, body] = m;
      for (const c of body.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        add(table, c[1]);
      }
    }
  }
  return tables;
};

/**
 * Split SQL into independently-scoped chunks.
 *
 * Aliases are scoped to a statement, not a file — migration 02 alone uses `p`
 * for public_lands in one function and for presence in another. Resolving
 * aliases file-wide produced 19 confident, entirely bogus failures on
 * hand-written SQL that has been running in production for months, which is a
 * good reminder that a checker nobody can trust is worse than no checker.
 *
 * Function bodies are delimited by $$, everything else by semicolons.
 */
const chunks = (sql) => {
  const out = [];
  const bodyRe = /\$\$([\s\S]*?)\$\$/g;
  let last = 0;
  for (const m of sql.matchAll(bodyRe)) {
    out.push(...sql.slice(last, m.index).split(';'));
    out.push(m[1]);
    last = m.index + m[0].length;
  }
  out.push(...sql.slice(last).split(';'));
  return out.filter((c) => c.trim().length > 0);
};

/**
 * Map alias -> table for one SQL body, from its FROM and JOIN clauses.
 */
const readAliases = (sql) => {
  const aliases = new Map();
  const re = /\b(?:from|join)\s+(public\.[a-z_][a-z0-9_]*)\s+(?:as\s+)?([a-z][a-z0-9_]*)\b/gi;
  for (const m of sql.matchAll(re)) {
    const [, table, alias] = m;
    // `on`, `where` etc. are keywords, not aliases.
    if (['on', 'where', 'using', 'left', 'inner', 'join', 'and', 'or'].includes(norm(alias))) continue;
    aliases.set(norm(alias), norm(table).replace(/^public\./, ''));
  }
  return aliases;
};

const run = () => {
  const schemaFiles = [
    path.join(rootDir, 'supabase_schema.sql'),
    ...fs
      .readdirSync(rootDir)
      .filter((f) => /^supabase_migration_\d+.*\.sql$/.test(f))
      .sort()
      .map((f) => path.join(rootDir, f))
  ].filter((f) => fs.existsSync(f));

  const tables = readSchema(schemaFiles);
  console.log(`Schema: ${tables.size} tables from ${schemaFiles.length} files\n`);

  let problems = 0;
  let checked = 0;

  for (const file of schemaFiles) {
    const name = path.basename(file);
    const sql = fs.readFileSync(file, 'utf8');

    for (const chunk of chunks(sql)) {
      const aliases = readAliases(chunk);
      if (aliases.size === 0) continue;

      const seen = new Set();
      for (const m of chunk.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
        const [full, alias, column] = m;
        const table = aliases.get(norm(alias));
        if (!table) continue; // not an alias we know — schema-qualified name etc.
        if (seen.has(full)) continue;
        seen.add(full);

        const columns = tables.get(table);
        if (!columns) {
          console.log(`  ${name}: references unknown table ${table} (as ${alias})`);
          problems += 1;
          continue;
        }
        checked += 1;
        if (!columns.has(norm(column))) {
          console.log(`  ${name}: ${table} has no column "${column}"  (written as ${full})`);
          problems += 1;
        }
      }
    }
  }

  console.log(`${checked} aliased column references checked`);

  if (problems > 0) {
    console.log(`\n${problems} problem${problems === 1 ? '' : 's'} found.`);
    console.log('A migration referencing a column that does not exist fails partway through,');
    console.log('which on a live database is worse than failing at the start.');
    process.exit(1);
  }
  console.log('No mismatches.');
};

run();
