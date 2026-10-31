import fs from 'node:fs';

/** Parse a .env file the way Docker Compose does (KEY=VALUE, quotes, comments). */
export function parseEnvFile(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(=?)\s*(.*)$/);
    if (!m) continue;
    const [, key, eq, rest] = m;
    if (!eq) {
      vars[key] = undefined;
      continue;
    }
    let value = rest;
    if (value.startsWith('"')) {
      const end = findClosing(value, '"');
      value = value.slice(1, end).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = value.slice(1, end === -1 ? undefined : end);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    vars[key] = value;
  }
  return vars;
}

function findClosing(s, q) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === q) return i;
  }
  return s.length;
}

export function readEnvFile(file) {
  return parseEnvFile(fs.readFileSync(file, 'utf8'));
}

/**
 * Interpolate ${VAR} / $VAR expressions using Compose semantics.
 * Supports :-, -, :?, ?, :+, + modifiers and $$ escapes.
 * @returns {{value: string, missing: {name: string, required: boolean, message?: string}[]}}
 */
export function interpolate(input, env) {
  const missing = [];
  const lookup = (name) => (Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined);

  const run = (str) => {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch !== '$') {
        out += ch;
        continue;
      }
      const next = str[i + 1];
      if (next === '$') {
        out += '$';
        i++;
        continue;
      }
      if (next === '{') {
        const end = matchBrace(str, i + 1);
        if (end === -1) {
          out += str.slice(i);
          break;
        }
        out += expand(str.slice(i + 2, end));
        i = end;
        continue;
      }
      const m = str.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (m) {
        const v = lookup(m[0]);
        if (v === undefined) missing.push({ name: m[0], required: false });
        out += v ?? '';
        i += m[0].length;
        continue;
      }
      out += ch;
    }
    return out;
  };

  const expand = (expr) => {
    const m = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/);
    if (!m) return `\${${expr}}`;
    const [, name, op, arg = ''] = m;
    const v = lookup(name);
    const unset = v === undefined;
    const empty = unset || v === '';
    switch (op) {
      case ':-':
        return empty ? run(arg) : v;
      case '-':
        return unset ? run(arg) : v;
      case ':?':
        if (empty) missing.push({ name, required: true, message: arg });
        return v ?? '';
      case '?':
        if (unset) missing.push({ name, required: true, message: arg });
        return v ?? '';
      case ':+':
        return empty ? '' : run(arg);
      case '+':
        return unset ? '' : run(arg);
      default:
        if (unset) missing.push({ name, required: false });
        return v ?? '';
    }
  };

  return { value: run(String(input)), missing };
}

function matchBrace(str, open) {
  let depth = 0;
  for (let i = open; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}' && --depth === 0) return i;
  }
  return -1;
}
