import { Document, visit, isSeq, isScalar } from 'yaml';
import { dependsOnMap, hasHealthcheck, imageBaseName, isStateful } from './rules.js';

// Readiness probes that ship inside the official images.
// "$$" escapes "$" so Compose does not interpolate on the host.
const HEALTHCHECKS = {
  postgres: ['CMD-SHELL', 'pg_isready -U "$${POSTGRES_USER:-postgres}" -d "$${POSTGRES_DB:-postgres}"'],
  postgis: ['CMD-SHELL', 'pg_isready -U "$${POSTGRES_USER:-postgres}"'],
  timescaledb: ['CMD-SHELL', 'pg_isready -U "$${POSTGRES_USER:-postgres}"'],
  mysql: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 --silent'],
  percona: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 --silent'],
  mariadb: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'],
  redis: ['CMD', 'redis-cli', 'ping'],
  'redis-stack': ['CMD', 'redis-cli', 'ping'],
  valkey: ['CMD', 'valkey-cli', 'ping'],
  keydb: ['CMD', 'keydb-cli', 'ping'],
  mongo: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"],
  rabbitmq: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping'],
  elasticsearch: ['CMD-SHELL', 'curl -fs http://localhost:9200/_cluster/health || exit 1'],
  opensearch: ['CMD-SHELL', 'curl -fsk https://localhost:9200/_cluster/health || curl -fs http://localhost:9200/_cluster/health || exit 1'],
  cassandra: ['CMD-SHELL', "cqlsh -e 'describe keyspaces' || exit 1"],
  couchdb: ['CMD-SHELL', 'curl -fs http://localhost:5984/_up || exit 1'],
  minio: ['CMD', 'mc', 'ready', 'local'],
  clickhouse: ['CMD', 'clickhouse-client', '--query', 'SELECT 1'],
  'clickhouse-server': ['CMD', 'clickhouse-client', '--query', 'SELECT 1'],
  influxdb: ['CMD', 'influx', 'ping'],
  neo4j: ['CMD-SHELL', 'wget -q --spider http://localhost:7474 || exit 1'],
  nats: ['CMD', 'nats-server', '--help'],
  etcd: ['CMD', 'etcdctl', 'endpoint', 'health'],
  consul: ['CMD', 'consul', 'members'],
};

export function healthcheckFor(service, name) {
  const base = imageBaseName(service.image) || String(name).toLowerCase();
  const test = HEALTHCHECKS[base];
  if (!test) return null;
  return { test, interval: '5s', timeout: '5s', retries: 10, start_period: '10s' };
}

/**
 * Build a compose.override.yaml-style patch that fixes readiness problems.
 * @returns {{yaml: string, notes: string[]}}
 */
export function buildFixPreview(model) {
  const services = model.services || {};
  const patch = {};
  const notes = [];
  const healthy = new Set(Object.keys(services).filter((n) => hasHealthcheck(services[n])));

  for (const [name, svc] of Object.entries(services)) {
    if (!isStateful(svc, name) || hasHealthcheck(svc)) continue;
    const hc = healthcheckFor(svc, name);
    if (hc) {
      (patch[name] ||= {}).healthcheck = hc;
      healthy.add(name);
    } else {
      notes.push(`"${name}": no built-in healthcheck template for ${imageBaseName(svc.image) || name}; add one manually.`);
    }
  }

  for (const [name, svc] of Object.entries(services)) {
    const deps = dependsOnMap(svc);
    const upgrade = {};
    for (const [dep, cfg] of Object.entries(deps)) {
      if (!services[dep]) continue;
      if (healthy.has(dep) && cfg.condition !== 'service_healthy' && (isStateful(services[dep], dep) || patch[dep]?.healthcheck)) {
        upgrade[dep] = { condition: 'service_healthy' };
      }
    }
    if (Object.keys(upgrade).length) {
      // Keep the other dependencies so the merged result is complete.
      const full = {};
      for (const [dep, cfg] of Object.entries(deps)) if (services[dep]) full[dep] = upgrade[dep] || { condition: cfg.condition };
      (patch[name] ||= {}).depends_on = full;
    }
  }

  for (const [name, svc] of Object.entries(services)) {
    if (!svc.image || svc.build) continue;
    const image = String(svc.image);
    const tag = image.split('/').pop().split(':')[1];
    if (!image.includes('@') && (!tag || tag === 'latest')) notes.push(`"${name}": pin "${image}" to a specific version tag.`);
  }

  const yaml = Object.keys(patch).length ? toYaml({ services: patch }) : '';
  return { yaml, notes };
}

function toYaml(data) {
  const doc = new Document(data);
  // Render healthcheck test arrays as ["CMD", "..."] like the Docker docs do.
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === 'test' && isSeq(pair.value)) pair.value.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
