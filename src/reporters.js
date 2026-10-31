// Output formats shared by every command: text, json, sarif, markdown and
// GitHub Actions workflow annotations.

export const SEVERITIES = ['error', 'warning', 'info'];
const RANK = { error: 3, warning: 2, info: 1, none: 99 };

export function atLeast(severity, threshold) {
  return RANK[severity] >= RANK[threshold];
}

export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      (a.file || '').localeCompare(b.file || '') ||
      (a.line || 0) - (b.line || 0) ||
      RANK[b.severity] - RANK[a.severity] ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

export function countBySeverity(findings) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function shouldUseColor(flag) {
  if (flag === false) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

export function colors(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39),
    bold: wrap(1, 22),
  };
}

export function severityLabel(severity, c) {
  if (severity === 'error') return c.red('[ERROR]  ');
  if (severity === 'warning') return c.yellow('[WARNING]');
  return c.blue('[INFO]   ');
}

export function renderJson(findings, meta = {}) {
  return JSON.stringify(
    { tool: meta.tool?.name, version: meta.tool?.version, summary: countBySeverity(findings), ...meta.extra, findings: sortFindings(findings) },
    null,
    2,
  );
}

export function renderSarif(findings, { tool, rules }) {
  const usedIds = [...new Set(findings.map((f) => f.ruleId))].sort();
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: tool.name,
              version: tool.version,
              informationUri: tool.uri,
              rules: usedIds.map((id) => {
                const rule = rules[id] || {};
                return {
                  id,
                  name: rule.name || id,
                  shortDescription: { text: rule.description || id },
                  helpUri: `${tool.uri}#rules`,
                  defaultConfiguration: { level: toSarifLevel(rule.severity || 'warning') },
                };
              }),
            },
          },
          results: sortFindings(findings).map((f) => ({
            ruleId: f.ruleId,
            level: toSarifLevel(f.severity),
            message: { text: f.fix ? `${f.message} Fix: ${f.fix}` : f.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: f.file || '.' },
                  region: { startLine: Math.max(1, f.line || 1) },
                },
              },
            ],
          })),
        },
      ],
    },
    null,
    2,
  );
}

function toSarifLevel(severity) {
  return severity === 'info' ? 'note' : severity;
}

export function renderMarkdown(findings, { tool, title }) {
  const counts = countBySeverity(findings);
  const lines = [`## ${title || tool.name}`, ''];
  lines.push(`**${counts.error}** errors · **${counts.warning}** warnings · **${counts.info}** info`, '');
  if (findings.length === 0) {
    lines.push('No issues found. :white_check_mark:');
    return lines.join('\n');
  }
  lines.push('| Severity | Rule | Location | Message |', '| --- | --- | --- | --- |');
  for (const f of sortFindings(findings)) {
    const loc = `\`${f.file || '.'}${f.line ? `:${f.line}` : ''}\``;
    const msg = (f.context ? `**${f.context}** — ` : '') + f.message + (f.fix ? `<br>Fix: \`${f.fix}\`` : '');
    lines.push(`| ${f.severity} | ${f.ruleId} | ${loc} | ${msg.replace(/\|/g, '\\|').replace(/\n/g, '<br>')} |`);
  }
  return lines.join('\n');
}

// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
export function renderGithub(findings) {
  const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return sortFindings(findings)
    .map((f) => {
      const cmd = f.severity === 'info' ? 'notice' : f.severity;
      const props = [`file=${escProp(f.file || '.')}`];
      if (f.line) props.push(`line=${f.line}`);
      props.push(`title=${escProp(`${f.ruleId}${f.context ? ` ${f.context}` : ''}`)}`);
      return `::${cmd} ${props.join(',')}::${escData(f.message + (f.fix ? ` Fix: ${f.fix}` : ''))}`;
    })
    .join('\n');
}

export const FORMATS = ['text', 'json', 'sarif', 'markdown', 'github'];
