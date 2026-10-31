import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, LineCounter, isMap, isSeq, isScalar } from 'yaml';
import { interpolate, readEnvFile } from './env.js';

// Default file names, in the order Docker Compose looks for them.
export const DEFAULT_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OVERRIDES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];

export function discoverFiles(dir) {
  const main = DEFAULT_FILES.find((f) => fs.existsSync(path.join(dir, f)));
  if (!main) return [];
  const files = [path.join(dir, main)];
  const override = OVERRIDES.find((f) => fs.existsSync(path.join(dir, f)));
  if (override) files.push(path.join(dir, override));
  return files;
}

/**
 * Load, interpolate and merge one or more compose files.
 * @param {string[]} files absolute paths
 * @param {{envFiles?: string[], useShellEnv?: boolean, projectDir?: string}} options
 */
export function loadProject(files, options = {}) {
  const projectDir = options.projectDir || path.dirname(files[0]);
  const errors = [];
  const env = {};
  const envSources = [];

  const envFiles = options.envFiles?.length ? options.envFiles : [path.join(projectDir, '.env')];
  for (const f of envFiles) {
    if (fs.existsSync(f)) {
      Object.assign(env, stripUndefined(readEnvFile(f)));
      envSources.push(f);
    } else if (options.envFiles?.length) {
      errors.push({ file: f, line: 1, message: `--env-file ${f} does not exist.` });
    }
  }
  if (options.useShellEnv !== false) Object.assign(env, process.env);

  const sources = [];
  const missingVars = [];
  let merged = {};
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true, merge: true });
    sources.push({ file, text, doc, lineCounter });
    if (doc.errors.length) {
      for (const e of doc.errors) {
        errors.push({ file, line: lineCounter.linePos(e.pos[0]).line, message: e.message.split('\n')[0] });
      }
      continue;
    }
    const data = doc.toJS({ maxAliasCount: 1000 }) ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) {
      errors.push({ file, line: 1, message: 'Top level of a compose file must be a mapping.' });
      continue;
    }
    const resolved = interpolateTree(data, env, [], (p, m) => missingVars.push({ file, path: p, ...m }));
    merged = mergeCompose(merged, resolved);
  }

  return { files, projectDir, sources, model: merged, env, envSources, missingVars, errors };
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function interpolateTree(node, env, at, onMissing) {
  if (typeof node === 'string') {
    const { value, missing } = interpolate(node, env);
    for (const m of missing) onMissing(at, m);
    return value;
  }
  if (Array.isArray(node)) return node.map((v, i) => interpolateTree(v, env, [...at, i], onMissing));
  if (node && typeof node === 'object') {
    // x-* extension fields are not interpolated by Compose.
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, at.length === 0 && k.startsWith('x-') ? v : interpolateTree(v, env, [...at, k], onMissing)]),
    );
  }
  return node;
}

const APPEND_KEYS = new Set(['ports', 'expose', 'dns', 'dns_search', 'tmpfs', 'cap_add', 'cap_drop', 'devices', 'volumes', 'secrets', 'configs', 'env_file', 'extra_hosts']);

/** Simplified Compose merge: maps merge recursively, known lists append, scalars override. */
export function mergeCompose(base, override, key = null) {
  if (Array.isArray(base) && Array.isArray(override)) {
    if (APPEND_KEYS.has(key)) return [...new Map([...base, ...override].map((v) => [JSON.stringify(v), v])).values()];
    return override;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) out[k] = k in base ? mergeCompose(base[k], v, k) : v;
    return out;
  }
  // depends_on / environment can switch between list and map syntax.
  if (key === 'depends_on' || key === 'environment' || key === 'labels') {
    return { ...toMap(base, key), ...toMap(override, key) };
  }
  return override;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toMap(v, key) {
  if (isPlainObject(v)) return v;
  if (!Array.isArray(v)) return {};
  if (key === 'depends_on') return Object.fromEntries(v.map((n) => [n, { condition: 'service_started' }]));
  return Object.fromEntries(v.map((e) => {
    const i = String(e).indexOf('=');
    return i === -1 ? [e, null] : [String(e).slice(0, i), String(e).slice(i + 1)];
  }));
}

/**
 * Find the source line for a path such as ['services', 'db', 'ports', 0].
 * Later files win (they override earlier ones); falls back to parent paths.
 */
export function locate(project, at) {
  for (let len = at.length; len >= 0; len--) {
    const sub = at.slice(0, len);
    for (let i = project.sources.length - 1; i >= 0; i--) {
      const { doc, lineCounter, file } = project.sources[i];
      if (doc.errors.length) continue;
      const node = len === 0 ? doc.contents : doc.getIn(sub, true);
      if (node && node.range) {
        // For map entries point at the key, not the value.
        const parent = len > 0 ? (len === 1 ? doc.contents : doc.getIn(sub.slice(0, -1), true)) : null;
        let offset = node.range[0];
        if (parent && isMap(parent)) {
          const pair = parent.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === sub[len - 1]);
          if (pair?.key?.range) offset = pair.key.range[0];
        }
        return { file, line: lineCounter.linePos(offset).line };
      }
    }
  }
  return { file: project.files[0], line: 1 };
}

/** The raw YAML node at a path in the last file that defines it. */
export function nodeAt(project, at) {
  for (let i = project.sources.length - 1; i >= 0; i--) {
    const { doc } = project.sources[i];
    if (doc.errors.length) continue;
    const node = doc.getIn(at, true);
    if (node !== undefined) return { node, source: project.sources[i] };
  }
  return null;
}

export { isMap, isSeq, isScalar };
