import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locate, nodeAt, isSeq, isScalar } from './load.js';
import { parsePort, probePort } from './ports.js';

export const RULES = {
  CD001: { name: 'yaml-syntax', severity: 'error', description: 'The compose file is not valid YAML.' },
  CD002: { name: 'no-services', severity: 'error', description: 'The project defines no services.' },
  CD003: { name: 'obsolete-version', severity: 'info', description: 'The top-level "version" key is obsolete in Compose v2 and ignored.' },
  CD004: { name: 'unknown-top-level-key', severity: 'error', description: 'Unknown top-level key (Compose rejects it).' },
  CD005: { name: 'unknown-service-key', severity: 'error', description: 'Unknown service key, usually a typo (Compose rejects it).' },
  CD010: { name: 'unresolved-variable', severity: 'warning', description: 'A ${VARIABLE} is not set in the shell or .env file and resolves to an empty string.' },
  CD011: { name: 'env-file-missing', severity: 'error', description: 'A file listed in env_file does not exist.' },
  CD012: { name: 'env-passthrough-unset', severity: 'info', description: 'An environment entry without a value is passed through from the shell, but is not set.' },
  CD020: { name: 'image-latest-tag', severity: 'warning', description: 'The image uses the implicit or explicit "latest" tag, so builds are not reproducible.' },
  CD021: { name: 'no-image-or-build', severity: 'error', description: 'A service needs either "image" or "build".' },
  CD022: { name: 'build-context-missing', severity: 'error', description: 'The build context or Dockerfile does not exist.' },
  CD030: { name: 'depends-on-unknown-service', severity: 'error', description: 'depends_on references a service that is not defined.' },
  CD031: { name: 'depends-on-cycle', severity: 'error', description: 'depends_on contains a dependency cycle.' },
  CD032: { name: 'dependency-not-verified', severity: 'warning', description: 'The service depends on a stateful service but only waits for its container to start, not to be ready.' },
  CD033: { name: 'healthy-condition-without-healthcheck', severity: 'error', description: 'condition: service_healthy is used, but the dependency has no healthcheck.' },
  CD034: { name: 'missing-healthcheck', severity: 'warning', description: 'A database / broker service has no healthcheck.' },
  CD040: { name: 'duplicate-host-port', severity: 'error', description: 'Two services publish the same host port.' },
  CD041: { name: 'host-port-in-use', severity: 'error', description: 'A published host port is already in use on this machine.' },
  CD042: { name: 'unquoted-port-mapping', severity: 'info', description: 'Port mappings should be quoted strings to avoid YAML number parsing surprises.' },
  CD043: { name: 'database-port-public', severity: 'info', description: 'A database port is published on all network interfaces.' },
  CD050: { name: 'bind-mount-missing', severity: 'warning', description: 'A bind-mount source path does not exist.' },
  CD051: { name: 'undeclared-volume', severity: 'error', description: 'A named volume is used but not declared under top-level "volumes".' },
  CD052: { name: 'undeclared-network', severity: 'error', description: 'A network is used but not declared under top-level "networks".' },
  CD053: { name: 'secret-or-config-invalid', severity: 'error', description: 'A secret or config is undeclared or its file is missing.' },
  CD060: { name: 'duplicate-container-name', severity: 'error', description: 'container_name must be unique.' },
  CD061: { name: 'invalid-restart-policy', severity: 'error', description: 'restart must be "no", "always", "on-failure[:N]" or "unless-stopped".' },
  CD062: { name: 'container-name-with-replicas', severity: 'error', description: 'A service with container_name cannot be scaled beyond one replica.' },
  CD070: { name: 'deprecated-links', severity: 'info', description: '"links" is legacy; services on the same network can reach each other by name.' },
};

const TOP_LEVEL_KEYS = new Set(['version', 'name', 'services', 'networks', 'volumes', 'secrets', 'configs', 'include', 'models']);
const SERVICE_KEYS = new Set(
  `annotations attach blkio_config build cap_add cap_drop cgroup cgroup_parent command configs container_name cpu_count cpu_percent
  cpu_period cpu_quota cpu_rt_period cpu_rt_runtime cpu_shares cpus cpuset credential_spec depends_on deploy develop device_cgroup_rules
  devices dns dns_opt dns_search domainname driver_opts entrypoint env_file environment expose extends external_links extra_hosts gpus
  group_add healthcheck hostname image init ipc isolation label_file labels links logging mac_address mem_limit mem_reservation
  mem_swappiness memswap_limit models network_mode networks oom_kill_disable oom_score_adj pid pids_limit platform ports post_start
  pre_stop privileged profiles provider pull_policy read_only restart runtime scale secrets security_opt shm_size stdin_open
  stop_grace_period stop_signal storage_opt sysctls tmpfs tty ulimits use_api_socket user userns_mode uts volumes volumes_from working_dir`.split(/\s+/),
);

// Images that hold state or accept connections slowly: they need a readiness check.
const STATEFUL = /^(postgres|postgis|timescaledb|mysql|mariadb|percona|mongo|mongodb|redis|redis-stack|valkey|keydb|rabbitmq|elasticsearch|opensearch|kafka|cp-kafka|zookeeper|cassandra|scylla|memcached|mssql|mssql-server|clickhouse|clickhouse-server|minio|neo4j|couchdb|couchbase|nats|influxdb|cockroach|etcd|consul|vault|keycloak|localstack)$/;

export function imageBaseName(image) {
  if (!image) return '';
  const noDigest = String(image).split('@')[0];
  const lastSlash = noDigest.lastIndexOf('/');
  const name = noDigest.slice(lastSlash + 1);
  return name.split(':')[0].toLowerCase();
}

export function isStateful(service, name) {
  const base = imageBaseName(service.image);
  return STATEFUL.test(base) || (!service.image && STATEFUL.test(String(name).toLowerCase()));
}

export function hasHealthcheck(service) {
  const hc = service.healthcheck;
  if (!hc || hc.disable === true) return false;
  if (Array.isArray(hc.test) && String(hc.test[0]).toUpperCase() === 'NONE') return false;
  return Boolean(hc.test);
}

export function dependsOnMap(service) {
  const d = service.depends_on;
  if (!d) return {};
  if (Array.isArray(d)) return Object.fromEntries(d.map((n) => [n, { condition: 'service_started' }]));
  return Object.fromEntries(Object.entries(d).map(([n, v]) => [n, { condition: 'service_started', ...(v || {}) }]));
}

function closest(word, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = levenshtein(word, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Parse a short-syntax volume "src:dst[:mode]" (Windows drive letters supported). */
export function parseVolume(entry) {
  if (entry && typeof entry === 'object') {
    return { type: entry.type || (entry.source && isPathLike(entry.source) ? 'bind' : 'volume'), source: entry.source, target: entry.target, createHostPath: entry.bind?.create_host_path };
  }
  const s = String(entry);
  const parts = [];
  let rest = s;
  const drive = rest.match(/^[A-Za-z]:[\\/]/);
  if (drive) {
    const idx = rest.indexOf(':', 2);
    parts.push(idx === -1 ? rest : rest.slice(0, idx));
    rest = idx === -1 ? '' : rest.slice(idx + 1);
  }
  if (rest) parts.push(...rest.split(':'));
  if (parts.length === 1) return { type: 'volume', source: null, target: parts[0] };
  const [source, target] = parts;
  return { type: isPathLike(source) ? 'bind' : 'volume', source, target };
}

function isPathLike(source) {
  return /^(\.|\/|~|[A-Za-z]:[\\/]|\\\\)/.test(String(source));
}

function resolveHostPath(p, projectDir) {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(projectDir, p);
}

function isRemoteContext(ctx) {
  return /^(https?:\/\/|git@|github\.com\/|ssh:\/\/)/.test(ctx) || ctx.endsWith('.git');
}

/**
 * Run every check against a loaded project.
 * @param {ReturnType<import('./load.js').loadProject>} project
 * @param {{checkPorts?: boolean, ignore?: Set<string>}} options
 */
export async function diagnose(project, options = {}) {
  const findings = [];
  const ignore = options.ignore || new Set();
  const rel = (f) => path.relative(process.cwd(), f).split(path.sep).join('/') || f;
  const add = (ruleId, at, message, extra = {}) => {
    if (ignore.has(ruleId)) return;
    const loc = extra.loc || locate(project, at);
    findings.push({ ruleId, severity: extra.severity || RULES[ruleId].severity, message, fix: extra.fix, context: extra.context, file: rel(loc.file), line: loc.line });
  };

  for (const e of project.errors) {
    findings.push({ ruleId: 'CD001', severity: 'error', message: e.message, file: rel(e.file), line: e.line });
  }
  if (project.errors.some((e) => project.files.includes(e.file))) return findings;

  const model = project.model;
  const services = model.services && typeof model.services === 'object' ? model.services : {};
  const names = Object.keys(services);

  if (!names.length && !model.include) add('CD002', ['services'], 'No services are defined.');
  if ('version' in model) add('CD003', ['version'], `"version: ${model.version}" is obsolete and ignored by Docker Compose v2.`, { fix: 'remove the version line' });
  for (const key of Object.keys(model)) {
    if (TOP_LEVEL_KEYS.has(key) || key.startsWith('x-')) continue;
    const hint = closest(key, TOP_LEVEL_KEYS);
    add('CD004', [key], `Unknown top-level key "${key}".`, { fix: hint ? `did you mean "${hint}"?` : 'prefix custom keys with x-' });
  }

  // Variables -----------------------------------------------------------
  const seenVars = new Set();
  for (const m of [...project.missingVars].sort((a, b) => Number(b.required) - Number(a.required))) {
    if (seenVars.has(m.name)) continue;
    seenVars.add(m.name);
    const where = m.path[0] === 'services' && m.path[1] ? `service "${m.path[1]}"` : undefined;
    if (m.required) {
      add('CD010', m.path, `${m.name} is required but not set${m.message ? `: ${m.message}` : ''}. "docker compose up" will fail.`, { severity: 'error', context: where, fix: `add ${m.name}=... to .env` });
    } else {
      add('CD010', m.path, `${m.name} is unresolved and defaults to an empty string.`, { context: where, fix: `add ${m.name}=... to .env, or use \${${m.name}:-default}` });
    }
  }

  // Services ------------------------------------------------------------
  const declaredVolumes = new Set(Object.keys(model.volumes || {}));
  const declaredNetworks = new Set(['default', ...Object.keys(model.networks || {})]);
  const containerNames = new Map();
  const hostPorts = new Map();

  for (const name of names) {
    const svc = services[name] || {};
    const at = ['services', name];
    const ctx = `service "${name}"`;

    for (const key of Object.keys(svc)) {
      if (SERVICE_KEYS.has(key) || key.startsWith('x-')) continue;
      const hint = closest(key, SERVICE_KEYS);
      add('CD005', [...at, key], `Unknown service key "${key}".`, { context: ctx, fix: hint ? `did you mean "${hint}"?` : undefined });
    }

    // image / build
    if (!svc.image && !svc.build && !svc.extends && !svc.provider) {
      add('CD021', at, 'Service has neither "image" nor "build".', { context: ctx, fix: 'add image: <name>:<tag> or build: .' });
    }
    if (svc.image && !svc.build) {
      const image = String(svc.image);
      const noDigest = !image.includes('@');
      const tag = image.split('/').pop().split(':')[1];
      if (noDigest && (!tag || tag === 'latest')) {
        add('CD020', [...at, 'image'], `Image "${image}" ${tag ? 'uses the "latest" tag' : 'has no tag (defaults to latest)'}; a new upstream release can break the stack.`, { context: ctx, fix: `pin a version, e.g. ${image.split(':')[0]}:<version>` });
      }
    }
    if (svc.build) {
      const build = typeof svc.build === 'string' ? { context: svc.build } : svc.build;
      const context = String(build.context ?? '.');
      if (!isRemoteContext(context)) {
        const ctxDir = resolveHostPath(context, project.projectDir);
        if (!fs.existsSync(ctxDir)) {
          add('CD022', [...at, 'build'], `Build context "${context}" does not exist.`, { context: ctx });
        } else if (!build.dockerfile_inline) {
          const dockerfile = String(build.dockerfile || 'Dockerfile');
          const dfPath = path.isAbsolute(dockerfile) ? dockerfile : path.join(ctxDir, dockerfile);
          if (!fs.existsSync(dfPath)) add('CD022', [...at, 'build'], `Dockerfile "${path.relative(project.projectDir, dfPath) || dockerfile}" does not exist.`, { context: ctx });
        }
      }
    }

    // env_file / environment
    const envFiles = svc.env_file === undefined ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
    envFiles.forEach((entry, i) => {
      const file = typeof entry === 'object' ? entry.path : entry;
      const required = typeof entry === 'object' ? entry.required !== false : true;
      if (required && file && !fs.existsSync(resolveHostPath(String(file), project.projectDir))) {
        add('CD011', [...at, 'env_file', ...(Array.isArray(svc.env_file) ? [i] : [])], `env_file "${file}" does not exist; "docker compose up" will fail.`, { context: ctx, fix: `create ${file}, or use { path: ${file}, required: false }` });
      }
    });
    const environment = svc.environment;
    const passthrough = Array.isArray(environment)
      ? environment.filter((e) => !String(e).includes('=')).map(String)
      : Object.entries(environment || {}).filter(([, v]) => v === null).map(([k]) => k);
    for (const key of passthrough) {
      if (project.env[key] === undefined) add('CD012', [...at, 'environment'], `${key} has no value and is not set in the shell, so it will be missing inside the container.`, { context: ctx });
    }

    // depends_on
    const deps = dependsOnMap(svc);
    for (const [dep, cfg] of Object.entries(deps)) {
      const depAt = [...at, 'depends_on', ...(Array.isArray(svc.depends_on) ? [svc.depends_on.indexOf(dep)] : [dep])];
      const target = services[dep];
      if (!target) {
        if (cfg.required !== false) add('CD030', depAt, `depends_on "${dep}", which is not a service in this project.`, { context: ctx, fix: closest(dep, names) ? `did you mean "${closest(dep, names)}"?` : undefined });
        continue;
      }
      if (cfg.condition === 'service_healthy' && !hasHealthcheck(target)) {
        add('CD033', depAt, `Waits for "${dep}" to be healthy, but "${dep}" has no healthcheck; Compose will fail to start the stack.`, { context: ctx, fix: `add a healthcheck to "${dep}" (see --fix-preview)` });
      } else if (cfg.condition === 'service_started' && isStateful(target, dep)) {
        add('CD032', depAt, `Startup dependency on "${dep}" is not verified: Compose only waits for the container to start, not for ${imageBaseName(target.image) || dep} to accept connections.`, { context: ctx, fix: `depends_on: { ${dep}: { condition: service_healthy } } with a healthcheck on "${dep}"` });
      }
    }

    if (isStateful(svc, name) && !hasHealthcheck(svc)) {
      add('CD034', at, `${imageBaseName(svc.image) || name} healthcheck missing; dependants cannot wait for it to be ready.`, { context: ctx, fix: 'run with --fix-preview for a ready-made healthcheck' });
    }

    // ports
    (Array.isArray(svc.ports) ? svc.ports : []).forEach((entry, i) => {
      const portAt = [...at, 'ports', i];
      const found = nodeAt(project, portAt);
      if (found && isScalar(found.node) && found.node.type === 'PLAIN' && String(found.node.value).includes(':')) {
        const low = parsePort(entry).some((b) => b.target !== null && b.target < 60);
        add('CD042', portAt, `Port mapping ${found.node.source ?? entry} is unquoted${low ? '; YAML 1.1 parsers read xx:yy with values below 60 as a base-60 number' : ''}.`, { context: ctx, severity: low ? 'warning' : 'info', fix: `"${entry}"` });
      }
      for (const b of parsePort(entry)) {
        const key = `${b.protocol}/${b.hostIp || '*'}/${b.published}`;
        const anyKey = `${b.protocol}/*/${b.published}`;
        const clash = hostPorts.get(key) || (b.hostIp ? hostPorts.get(anyKey) : [...hostPorts.entries()].find(([k]) => k.startsWith(`${b.protocol}/`) && k.endsWith(`/${b.published}`))?.[1]);
        if (clash && clash.service !== name) {
          add('CD040', portAt, `Host port ${b.published}/${b.protocol} is also published by service "${clash.service}".`, { context: ctx });
        }
        hostPorts.set(key, { service: name, at: portAt, binding: b });
        if (isStateful(svc, name) && (!b.hostIp || b.hostIp === '0.0.0.0' || b.hostIp === '::')) {
          add('CD043', portAt, `${imageBaseName(svc.image) || name} port ${b.published} is reachable from other machines on your network.`, { context: ctx, fix: `"127.0.0.1:${b.published}:${b.target}"` });
        }
      }
    });

    // volumes
    (Array.isArray(svc.volumes) ? svc.volumes : []).forEach((entry, i) => {
      const v = parseVolume(entry);
      const volAt = [...at, 'volumes', i];
      if (v.type === 'bind' && v.source) {
        const host = resolveHostPath(String(v.source), project.projectDir);
        if (!fs.existsSync(host)) {
          const explicitNoCreate = v.createHostPath === false;
          add('CD050', volAt, `Bind mount source "${v.source}" does not exist. ${explicitNoCreate ? 'Compose will refuse to start.' : 'Docker will create an empty directory there, so a file you meant to mount shows up as a directory.'}`, { context: ctx, severity: explicitNoCreate ? 'error' : undefined });
        }
      } else if (v.type === 'volume' && v.source && !declaredVolumes.has(v.source)) {
        add('CD051', volAt, `Named volume "${v.source}" is not declared under top-level "volumes".`, { context: ctx, fix: `volumes:\n  ${v.source}: {}` });
      }
    });

    // networks
    const nets = Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks || {});
    for (const net of nets) {
      if (!declaredNetworks.has(net)) add('CD052', [...at, 'networks'], `Network "${net}" is not declared under top-level "networks".`, { context: ctx });
    }

    // secrets / configs
    for (const kind of ['secrets', 'configs']) {
      const declared = model[kind] || {};
      (Array.isArray(svc[kind]) ? svc[kind] : []).forEach((entry, i) => {
        const source = typeof entry === 'object' ? entry.source : entry;
        if (!(source in declared)) add('CD053', [...at, kind, i], `${kind.slice(0, -1)} "${source}" is not declared under top-level "${kind}".`, { context: ctx });
      });
    }

    // container_name / restart / links
    if (svc.container_name) {
      const other = containerNames.get(svc.container_name);
      if (other) add('CD060', [...at, 'container_name'], `container_name "${svc.container_name}" is also used by service "${other}".`, { context: ctx });
      containerNames.set(svc.container_name, name);
      const replicas = svc.deploy?.replicas ?? svc.scale;
      if (Number(replicas) > 1) add('CD062', [...at, 'container_name'], `container_name is set but ${replicas} replicas are requested.`, { context: ctx, fix: 'remove container_name' });
    }
    if (svc.restart !== undefined) {
      const r = svc.restart;
      if (r === false) add('CD061', [...at, 'restart'], 'restart: no is parsed as the boolean false by some YAML parsers.', { context: ctx, fix: 'restart: "no"' });
      else if (!/^(no|always|unless-stopped|on-failure(:\d+)?)$/.test(String(r))) add('CD061', [...at, 'restart'], `Invalid restart policy "${r}".`, { context: ctx, fix: 'use "no", always, on-failure, on-failure:3 or unless-stopped' });
    }
    if (svc.links) add('CD070', [...at, 'links'], '"links" is a legacy feature.', { context: ctx, fix: 'remove links; use the service name as hostname (and depends_on for start order)' });
  }

  // Cycles ----------------------------------------------------------------
  const state = {};
  const stack = [];
  const visit = (n) => {
    if (state[n] === 'done' || !services[n]) return;
    if (state[n] === 'active') {
      const cycle = [...stack.slice(stack.indexOf(n)), n];
      add('CD031', ['services', n, 'depends_on'], `Dependency cycle: ${cycle.join(' -> ')}.`, { context: `service "${n}"` });
      return;
    }
    state[n] = 'active';
    stack.push(n);
    for (const d of Object.keys(dependsOnMap(services[n] || {}))) visit(d);
    stack.pop();
    state[n] = 'done';
  };
  names.forEach(visit);

  // Top-level secrets/configs files -------------------------------------
  for (const kind of ['secrets', 'configs']) {
    for (const [key, def] of Object.entries(model[kind] || {})) {
      if (def?.file && !fs.existsSync(resolveHostPath(String(def.file), project.projectDir))) {
        add('CD053', [kind, key, 'file'], `${kind.slice(0, -1)} "${key}" file "${def.file}" does not exist.`);
      }
    }
  }

  // Local port availability ----------------------------------------------
  if (options.checkPorts !== false) {
    for (const { service, at, binding } of hostPorts.values()) {
      if (binding.protocol !== 'tcp') continue;
      const status = await probePort(binding.published, binding.hostIp);
      if (status === 'in-use') {
        add('CD041', at, `Port ${binding.published} already occupied on this machine.`, { context: `service "${service}"`, fix: 'stop the process using it (or this stack if it is already running), or change the published port' });
      } else if (status === 'forbidden') {
        add('CD041', at, `Port ${binding.published} cannot be bound (reserved by the OS, e.g. a Hyper-V/WSL excluded port range).`, { context: `service "${service}"`, fix: 'choose another host port' });
      }
    }
  }

  return dedupe(findings);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const k = `${f.ruleId}|${f.file}|${f.line}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export { isSeq };
