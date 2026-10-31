import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { interpolate, parseEnvFile } from '../src/env.js';
import { parsePort, probePort } from '../src/ports.js';
import { loadProject, mergeCompose } from '../src/load.js';
import { diagnose, parseVolume } from '../src/rules.js';
import { buildFixPreview } from '../src/fix.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'composedoctor.js');

function project(yaml, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composedoctor-'));
  fs.writeFileSync(path.join(dir, 'compose.yaml'), yaml);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { dir, load: () => loadProject([path.join(dir, 'compose.yaml')], { useShellEnv: false }) };
}

async function ruleIds(yaml, files) {
  const p = project(yaml, files).load();
  return (await diagnose(p, { checkPorts: false })).map((f) => f.ruleId);
}

test('interpolate implements Compose substitution semantics', () => {
  const env = { A: 'a', EMPTY: '' };
  assert.equal(interpolate('${A}-$A', env).value, 'a-a');
  assert.equal(interpolate('${EMPTY:-x}|${EMPTY-x}|${NOPE-y}', env).value, 'x||y');
  assert.equal(interpolate('${A:+set}|${NOPE:+set}', env).value, 'set|');
  assert.equal(interpolate('$$HOME and $${A}', env).value, '$HOME and ${A}');
  assert.equal(interpolate('${NOPE:-${A}}', env).value, 'a');
  assert.deepEqual(interpolate('${NOPE}', env).missing, [{ name: 'NOPE', required: false }]);
  assert.deepEqual(interpolate('${NOPE:?boom}', env).missing, [{ name: 'NOPE', required: true, message: 'boom' }]);
  assert.equal(interpolate('${EMPTY?x}', env).missing.length, 0);
});

test('parseEnvFile handles quotes, comments and export', () => {
  const vars = parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'lit $x\'\nD=val # comment\nE\n');
  assert.deepEqual(vars, { A: '1', B: 'two words', C: 'lit $x', D: 'val', E: undefined });
});

test('parsePort handles short, long, ranges, IPs and protocols', () => {
  assert.deepEqual(parsePort('8080:80'), [{ hostIp: '', published: 8080, target: 80, protocol: 'tcp' }]);
  assert.deepEqual(parsePort('127.0.0.1:5432:5432/tcp')[0].hostIp, '127.0.0.1');
  assert.equal(parsePort('53:53/udp')[0].protocol, 'udp');
  assert.deepEqual(parsePort('80'), []);
  assert.equal(parsePort('3000-3002:3000-3002').length, 3);
  assert.equal(parsePort('[::1]:8080:80')[0].hostIp, '::1');
  assert.equal(parsePort({ target: 80, published: '8081' })[0].published, 8081);
  assert.deepEqual(parsePort({ target: 80 }), []);
});

test('parseVolume distinguishes binds, named and anonymous volumes', () => {
  assert.equal(parseVolume('./src:/app').type, 'bind');
  assert.equal(parseVolume('data:/var/lib/data').type, 'volume');
  assert.equal(parseVolume('/var/lib/data').source, null);
  assert.equal(parseVolume('C:\\code:/app:ro').source, 'C:\\code');
  assert.equal(parseVolume({ type: 'bind', source: './x', target: '/x' }).type, 'bind');
});

test('mergeCompose merges maps, appends ports and normalises depends_on', () => {
  const merged = mergeCompose(
    { services: { a: { image: 'x:1', ports: ['80:80'], depends_on: ['b'] } } },
    { services: { a: { image: 'x:2', ports: ['81:81'], depends_on: { c: { condition: 'service_healthy' } } } } },
  );
  assert.equal(merged.services.a.image, 'x:2');
  assert.deepEqual(merged.services.a.ports, ['80:80', '81:81']);
  assert.deepEqual(Object.keys(merged.services.a.depends_on), ['b', 'c']);
});

test('a well-formed project is clean', async () => {
  const ids = await ruleIds(
    `services:
  web:
    image: nginx:1.27
    ports: ["127.0.0.1:8080:80"]
    depends_on:
      db: { condition: service_healthy }
  db:
    image: postgres:16
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
volumes:
  pgdata:
`,
  );
  assert.deepEqual(ids, []);
});

test('detects syntax errors with a line number', async () => {
  const p = project('services:\n  web:\n    image: nginx:1\n   bad: indent\n').load();
  const findings = await diagnose(p, { checkPorts: false });
  assert.equal(findings[0].ruleId, 'CD001');
  assert.ok(findings[0].line >= 3);
});

test('detects variable, env_file and typo problems', async () => {
  const ids = await ruleIds(`version: "3"
services:
  app:
    image: app:1
    environment:
      A: \${MISSING}
      B: \${REQUIRED:?set it}
      C:
    env_file: [.env.local]
    enviroment: {}
servics: {}
`);
  for (const id of ['CD003', 'CD004', 'CD005', 'CD010', 'CD011', 'CD012']) assert.ok(ids.includes(id), id);
});

test('reads variables from .env next to the compose file', async () => {
  const ids = await ruleIds('services:\n  app:\n    image: app:${TAG}\n', { '.env': 'TAG=1.2.3\n' });
  assert.deepEqual(ids, []);
});

test('detects dependency and healthcheck problems', async () => {
  const ids = await ruleIds(`services:
  api:
    image: api:1
    depends_on: [db, ghost]
  worker:
    image: w:1
    depends_on:
      cache: { condition: service_healthy }
  db:
    image: postgres:16
  cache:
    image: redis:7
  a:
    image: a:1
    depends_on: [b]
  b:
    image: b:1
    depends_on: [a]
`);
  for (const id of ['CD030', 'CD031', 'CD032', 'CD033', 'CD034']) assert.ok(ids.includes(id), id);
});

test('detects image, build, port, volume, network and restart problems', async () => {
  const ids = await ruleIds(`services:
  a:
    image: nginx
    ports: [8080:80, "5432:5432"]
    volumes: [./missing:/x, undeclared:/y]
    networks: [backend]
    restart: sometimes
    container_name: same
    links: [b]
  b:
    build: ./nope
    ports: ["8080:8080"]
    container_name: same
  c:
    command: echo
  d:
    image: postgres:16
    ports: ["15432:5432"]
    healthcheck: { test: ["CMD", "pg_isready"] }
    secrets: [nope]
`);
  for (const id of ['CD020', 'CD021', 'CD022', 'CD040', 'CD042', 'CD043', 'CD050', 'CD051', 'CD052', 'CD053', 'CD060', 'CD061', 'CD070']) {
    assert.ok(ids.includes(id), id);
  }
});

test('detects a host port that is already in use', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(await probePort(port), 'in-use');
    const p = project(`services:\n  a:\n    image: a:1\n    ports: ["${port}:80"]\n`).load();
    const findings = await diagnose(p, { checkPorts: true });
    assert.ok(findings.some((f) => f.ruleId === 'CD041'));
  } finally {
    server.close();
  }
});

test('fix preview adds healthchecks and service_healthy conditions', () => {
  const p = project(`services:
  api:
    image: api:1
    depends_on: [db, redis, other]
  db:
    image: postgres:16-alpine
  redis:
    image: redis:7
  other:
    image: other:1
`).load();
  const { yaml } = buildFixPreview(p.model);
  const patch = parse(yaml);
  assert.equal(patch.services.db.healthcheck.test[0], 'CMD-SHELL');
  assert.deepEqual(patch.services.redis.healthcheck.test, ['CMD', 'redis-cli', 'ping']);
  assert.deepEqual(patch.services.api.depends_on, {
    db: { condition: 'service_healthy' },
    redis: { condition: 'service_healthy' },
    other: { condition: 'service_started' },
  });

  // Applying the override makes the readiness findings disappear.
  const merged = mergeCompose(p.model, patch);
  return diagnose({ ...p, model: merged }, { checkPorts: false }).then((findings) => {
    assert.deepEqual(findings.filter((f) => ['CD032', 'CD033', 'CD034'].includes(f.ruleId)), []);
  });
});

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, NO_COLOR: '1' } });
}

test('CLI: exit codes and output formats', () => {
  const broken = run(['-f', 'fixtures/broken/compose.yaml', '--no-port-check', '--ignore-shell-env']);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /COMPOSE DOCTOR/);
  assert.match(broken.stdout, /findings detected/);

  assert.equal(run(['--project-directory', 'fixtures/clean', '--no-port-check', '--ignore-shell-env']).status, 0);
  assert.equal(run(['-f', 'fixtures/broken/compose.yaml', '--no-port-check', '--fail-on', 'none']).status, 0);

  const json = JSON.parse(run(['-f', 'fixtures/broken/compose.yaml', '--no-port-check', '--format', 'json', '--fix-preview']).stdout);
  assert.ok(json.summary.error > 0);
  assert.match(json.fixPreview, /service_healthy/);

  const sarif = JSON.parse(run(['-f', 'fixtures/broken/compose.yaml', '--no-port-check', '--format', 'sarif']).stdout);
  assert.equal(sarif.runs[0].tool.driver.name, 'ComposeDoctor');
  assert.match(run(['-f', 'fixtures/broken/compose.yaml', '--no-port-check', '--format', 'github']).stdout, /^::error file=fixtures\/broken\/compose.yaml,line=\d+/m);

  assert.equal(run(['-f', 'nope.yaml']).status, 2);
  assert.equal(run(['--project-directory', os.tmpdir()]).status, 2);
  assert.equal(run(['rules']).status, 0);
});

test('CLI: --write-override writes a valid file and refuses to overwrite', () => {
  const { dir } = project('services:\n  api:\n    image: api:1\n    depends_on: [db]\n  db:\n    image: postgres:16\n');
  const target = path.join(dir, 'compose.override.yaml');
  const first = run(['-f', path.join(dir, 'compose.yaml'), '--no-port-check', '--write-override', target]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(parse(fs.readFileSync(target, 'utf8')).services.db.healthcheck);
  assert.equal(run(['-f', path.join(dir, 'compose.yaml'), '--no-port-check', '--write-override', target]).status, 2);

  // The project with the generated override is clean of readiness issues.
  const after = run(['--project-directory', dir, '--no-port-check', '--format', 'json']);
  const ids = JSON.parse(after.stdout).findings.map((f) => f.ruleId);
  assert.ok(!ids.includes('CD032') && !ids.includes('CD034'), ids.join(','));
});
