import net from 'node:net';

/**
 * Normalize a Compose port entry (short or long syntax) to published bindings.
 * Returns [] for container-only ports (Docker picks a random host port).
 * @returns {{hostIp: string, published: number, target: number|null, protocol: string}[]}
 */
export function parsePort(entry) {
  if (entry && typeof entry === 'object') {
    const protocol = entry.protocol || 'tcp';
    const hostIp = entry.host_ip || '';
    if (entry.published === undefined || entry.published === null || entry.published === '') return [];
    return expandRange(String(entry.published)).map((published, i) => ({
      hostIp,
      published,
      target: Number(entry.target) + i || null,
      protocol,
    }));
  }
  let spec = String(entry).trim();
  let protocol = 'tcp';
  const slash = spec.lastIndexOf('/');
  if (slash !== -1) {
    protocol = spec.slice(slash + 1).toLowerCase();
    spec = spec.slice(0, slash);
  }
  // [host_ip:]host:container, with IPv6 host IPs written as [::1]
  let hostIp = '';
  const ipv6 = spec.match(/^\[([^\]]+)\]:(.*)$/);
  if (ipv6) {
    hostIp = ipv6[1];
    spec = ipv6[2];
  }
  const parts = spec.split(':');
  if (parts.length === 1) return []; // container port only
  if (parts.length === 3) hostIp = parts.shift();
  const [host, container] = parts;
  if (!host) return [];
  const hosts = expandRange(host);
  const targets = expandRange(container);
  return hosts.map((published, i) => ({ hostIp, published, target: targets[i] ?? targets[0] ?? null, protocol }));
}

function expandRange(s) {
  const m = String(s).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return [];
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  const out = [];
  for (let p = from; p <= to && out.length < 1000; p++) out.push(p);
  return out;
}

/**
 * Check whether a TCP port is free on this machine.
 * @returns {Promise<'free'|'in-use'|'forbidden'>}
 */
export async function probePort(port, hostIp = '') {
  const host = hostIp && hostIp !== '0.0.0.0' && hostIp !== '::' ? hostIp : '0.0.0.0';
  const listenResult = await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? 'in-use' : err.code === 'EACCES' ? 'forbidden' : err.code === 'EADDRNOTAVAIL' ? 'free' : 'free'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve('free')));
  });
  if (listenResult !== 'free') return listenResult;
  // On Windows a wildcard bind can succeed even if 127.0.0.1:port is taken.
  const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const connected = await new Promise((resolve) => {
    const socket = net.connect({ port, host: connectHost });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  return connected ? 'in-use' : 'free';
}
