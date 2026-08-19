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
 *
 * TWO BLIND SPOTS IT USED TO HAVE, BOTH OF WHICH COST A FEATURE
 *
 * 1. It only read ALIASED references (`h.user_id` after `join ... h`). A
 *    trigger body reaching straight for `new.<column>` was invisible, and
 *    that is exactly where migration 08's `new.point_count` sat — on a table
 *    with no such column — silently rejecting every telemetry batch for
 *    releases. Trigger bodies are now checked against the table the trigger
 *    is actually attached to.
 *
 * 2. It scanned comments as if they were code, so writing about a bug in a
 *    comment reported the bug. Comments are stripped first now.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Postgres identifiers are case-insensitive unless quoted; we lower-case. */
const norm = (s) => s.trim().toLowerCase();

/**
 * Remove `--` and block comments, leaving string literals alone.
 *
 * Naively deleting from `--` to end of line would eat the second half of
 * `reject_reason := 'not dash-mounted -- see above'`, and naively keeping
 * comments means a note explaining a past bug reads as the bug. So: walk the
 * text once, tracking whether we are inside a quoted string.
 *
 * Replaced with spaces rather than deleted so that nothing which was on
 * separate lines gets joined into a token that was never written.
 */
const stripComments = (sql) => {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (two === '/*') {
      let depth = 1;            // Postgres block comments nest.
      out += '  ';
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') { depth += 1; out += '  '; i += 2; continue; }
        if (sql.slice(i, i + 2) === '*/') { depth -= 1; out += '  '; i += 2; continue; }
        out += sql[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (sql[i] === "'") {
      out += sql[i];
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'") { i += 1; break; }   // '' escapes handled by re-entry
        i += 1;
      }
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
};

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

/**
 * Map trigger-function name -> the tables its triggers are attached to.
 *
 * `create trigger x before insert on public.foo for each row execute
 *  function public.bar()` means every `new.<col>` in bar's body must be a
 * column of foo. A function can serve several tables, in which case a column
 * only has to exist on one of them.
 */
const readTriggerTargets = (files) => {
  const targets = new Map();
  const re =
    /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+[\w."]+\s+([\s\S]*?)\s+execute\s+(?:function|procedure)\s+([\w.]+)\s*\(/gi;
  for (const file of files) {
    const sql = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of sql.matchAll(re)) {
      const [, clause, fn] = m;
      const on = clause.match(/\bon\s+([\w.]+)/i);
      if (!on) continue;
      const key = norm(fn).replace(/^public\./, '');
      if (!targets.has(key)) targets.set(key, new Set());
      targets.get(key).add(norm(on[1]).replace(/^public\./, ''));
    }
  }
  return targets;
};

/** Map function name -> body, for `returns trigger` functions only. */
const readTriggerBodies = (files) => {
  const bodies = [];
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\([^)]*\)\s*returns\s+trigger\b([\s\S]*?)\$\$([\s\S]*?)\$\$/gi;
  for (const file of files) {
    const sql = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of sql.matchAll(re)) {
      bodies.push({
        file: path.basename(file),
        fn: norm(m[1]).replace(/^public\./, ''),
        body: m[3]
      });
    }
  }
  return bodies;
};

/**
 * Check `new.<col>` / `old.<col>` in every trigger body against the table the
 * trigger fires on. Returns the number of problems reported.
 *
 * Skipped deliberately: `new` and `old` also carry `tg_*`-adjacent record
 * plumbing in some dialects, and a function attached to no trigger in these
 * files cannot be resolved — both are left alone rather than guessed at.
 */
const checkTriggerBodies = (files, tables) => {
  const targets = readTriggerTargets(files);
  let problems = 0;
  let checked = 0;

  for (const { file, fn, body } of readTriggerBodies(files)) {
    const onTables = targets.get(fn);
    if (!onTables || onTables.size === 0) continue;

    const seen = new Set();
    for (const m of body.matchAll(/\b(new|old)\.([a-z_][a-z0-9_]*)\b/gi)) {
      const [full, , column] = m;
      const key = norm(full);
      if (seen.has(key)) continue;
      seen.add(key);

      let known = false;
      let anyTableKnown = false;
      for (const table of onTables) {
        const columns = tables.get(table);
        if (!columns) continue;
        anyTableKnown = true;
        if (columns.has(norm(column))) { known = true; break; }
      }
      if (!anyTableKnown) continue;

      checked += 1;
      if (!known) {
        const where = [...onTables].join(' / ');
        console.log(`  ${file}: ${where} has no column "${column}"  (written as ${full} in ${fn}())`);
        problems += 1;
      }
    }
  }

  return { problems, checked };
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
    const sql = stripComments(fs.readFileSync(file, 'utf8'));

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

  const trigger = checkTriggerBodies(schemaFiles, tables);
  problems += trigger.problems;

  console.log(`${checked} aliased column references checked`);
  console.log(`${trigger.checked} new./old. references in trigger bodies checked`);

  if (problems > 0) {
    console.log(`\n${problems} problem${problems === 1 ? '' : 's'} found.`);
    console.log('A migration referencing a column that does not exist fails partway through,');
    console.log('which on a live database is worse than failing at the start.');
    process.exit(1);
  }
  console.log('No mismatches.');
};

run();