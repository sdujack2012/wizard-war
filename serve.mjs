// Zero-dependency static file server for local development and device testing.
// Usage: node serve.mjs [port] [--host]
//   node serve.mjs 5173          -> http://localhost:5173
//   node serve.mjs 5173 --host   -> also binds 0.0.0.0 so a phone on the same
//                                   Wi-Fi can open http://<your-lan-ip>:5173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(import.meta.dirname);
const args = process.argv.slice(2);
const HOST_MODE = args.includes('--host');
const portArg = args.find((a) => /^\d+$/.test(a));
const PORT = Number(portArg ?? process.env.PORT ?? 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function safeResolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = normalize(join(ROOT, clean));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  try {
    let target = safeResolve(req.url === '/' ? '/index.html' : req.url);
    if (!target) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = join(target, 'index.html');
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
      // Required if you later add SharedArrayBuffer / high-res timers.
      'cross-origin-opener-policy': 'same-origin',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`500 ${err?.message ?? err}`);
  }
});

server.listen(PORT, HOST_MODE ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`RUNE PRESSURE dev server -> http://localhost:${PORT}/`);
  if (HOST_MODE) {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  on-device (same Wi-Fi) -> http://${net.address}:${PORT}/`);
        }
      }
    }
  }
});
