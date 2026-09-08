// Fresh CHINO database bootstrap. Existing deployments use normal migrations.
// node setup-db.js --dry-run lists the exact plan without accessing Supabase.
// node setup-db.js applies it to the dedicated CHINO project in .env.local.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const repoRoot = __dirname;
const firstForwardVersion = '20260713213000';
const migrations = fs.readdirSync(path.join(repoRoot, 'supabase', 'migrations'))
  .filter(name => /^\d+_.+\.sql$/.test(name))
  .sort()
  .map(name => ({
    name,
    version: name.split('_')[0],
    file: path.join(repoRoot, 'supabase', 'migrations', name),
  }));
const forwardMigrations = migrations.filter(item => item.version >= firstForwardVersion);

function loadLocalEnv() {
  const file = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
    }));
}

function literal(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

const migrationHistorySchema = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);`;

function recordMigration(item) {
  return `insert into supabase_migrations.schema_migrations (version, name)
values (${literal(item.version)}, ${literal(item.name.replace(/^\d+_/, '').replace(/\.sql$/, ''))})
on conflict (version) do nothing;`;
}

async function run() {
  const batchArgument = process.argv.find(argument => argument.startsWith('--batch-size='));
  const batchSize = batchArgument ? Number(batchArgument.slice('--batch-size='.length)) : 1;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new Error('Migration batch size must be an integer from 1 to 20.');
  }
  console.log('CHINO fresh installation: consolidated baseline, then ' + forwardMigrations.length + ' forward migrations.');
  if (process.argv.includes('--dry-run')) {
    console.log('SETUP_NEW_SUPABASE.sql');
    forwardMigrations.forEach(item => console.log('supabase/migrations/' + item.name));
    return;
  }

  const localEnv = loadLocalEnv();
  const env = { ...process.env, ...localEnv };
  const useCli = process.argv.includes('--cli') || !localEnv.SUPABASE_ACCESS_TOKEN;
  const ref = String(env.SUPABASE_PROJECT_REF || '').trim();
  if (ref !== 'wskzptxekldhsxluhgos') {
    throw new Error('Bootstrap is restricted to the dedicated CHINO Singapore project.');
  }
  const token = String(localEnv.SUPABASE_ACCESS_TOKEN || '').trim();
  if (!/^[a-z0-9]{20}$/.test(ref) || (!useCli && !token)) {
    throw new Error('Set the new SUPABASE_PROJECT_REF, then use --cli with an authenticated CLI or supply SUPABASE_ACCESS_TOKEN in .env.local.');
  }
  const expectedUrl = `https://${ref}.supabase.co`;
  if (env.SUPABASE_URL && env.SUPABASE_URL.replace(/\/+$/, '') !== expectedUrl) {
    throw new Error('SUPABASE_URL and SUPABASE_PROJECT_REF identify different projects.');
  }

  function cli(args) {
    const cliEnv = { ...process.env };
    // --cli explicitly chooses the current CLI login, never an unrelated
    // token inherited from another project or an old shell session.
    delete cliEnv.SUPABASE_ACCESS_TOKEN;
    const output = execFileSync(env.SUPABASE_CLI || 'supabase', [...args, '--output', 'json'], {
      cwd: repoRoot, env: cliEnv, encoding: 'utf8', timeout: 180000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
    });
    const parsed = JSON.parse(output);
    return parsed.rows || parsed;
  }

  async function management(endpoint, payload) {
    if (useCli) {
      if (endpoint === 'projects') return cli(['projects', 'list']);
      if (endpoint !== `projects/${ref}/database/query` || !payload?.query) {
        throw new Error('Unsupported CLI bootstrap operation.');
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chino-bootstrap-'));
      const file = path.join(directory, 'migration.sql');
      try {
        fs.writeFileSync(file, payload.query);
        return cli(['db', 'query', '--linked', '--project-ref', ref, '--file', file]);
      } finally {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(directory);
      }
    }
    const response = await fetch('https://api.supabase.com/v1/' + endpoint, {
      method: payload ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(180000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error('Supabase management request failed (' + response.status + '): ' + raw.slice(0, 500));
    return raw ? JSON.parse(raw) : null;
  }
  async function query(sql) {
    return management(`projects/${ref}/database/query`, { query: sql });
  }

  const projects = await management('projects');
  const project = projects.find(item => item.id === ref);
  if (!project || !/chino/i.test(project.name || '') ||
      project.organization_id !== 'xvtjpartlhxcyirwkhgo' || project.region !== 'ap-southeast-1') {
    throw new Error('Refusing bootstrap: the selected project is not CHINO Singapore in its dedicated organization.');
  }
  console.log('Verified dedicated project: ' + project.name + ' (' + ref + ')');
  await query(`do $$ begin
    if to_regclass('public.bookings') is not null
       or to_regclass('public.courts') is not null
       or to_regclass('public.accounts') is not null then
      raise exception 'Fresh bootstrap refused: application tables already exist. Apply normal migrations instead.';
    end if;
  end $$;`);

  await query(fs.readFileSync(path.join(repoRoot, 'SETUP_NEW_SUPABASE.sql'), 'utf8'));
  // Only the bootstrap/service role can configure maintenance routing.
  await query(`insert into public.chino_backend_config (id, project_url)
values (true, ${literal(expectedUrl)})
on conflict (id) do update set project_url = excluded.project_url;`);
  await query(migrationHistorySchema + '\n' + migrations
    .filter(item => item.version < firstForwardVersion)
    .map(recordMigration).join('\n'));
  console.log('Consolidated baseline installed and prior migration history recorded.');

  for (let index = 0; index < forwardMigrations.length; index += batchSize) {
    const batch = forwardMigrations.slice(index, index + batchSize);
    // Each request preserves migration order and records only successful SQL.
    await query(batch.map(item => fs.readFileSync(item.file, 'utf8') + '\n' + recordMigration(item)).join('\n'));
    for (const item of batch) console.log('Applied ' + item.name);
  }
  console.log('CHINO schema, private storage, Realtime and isolated maintenance jobs are ready.');
  console.log('No venue courts, users, payment recipients or business details were copied.');
}

run().catch(error => {
  console.error('Database setup stopped: ' + error.message);
  process.exitCode = 1;
});
