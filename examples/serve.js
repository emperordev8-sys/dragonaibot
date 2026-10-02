// Run: npm run demo   then open http://localhost:8080
// Tiny static file server for the demo chart and the examples (development only).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};
const allowed = ['src', 'examples', 'demo'].map((d) => join(root, d) + sep);
const port = Number(process.env.PORT || 8080);

http
  .createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path === sep || path === '/') {
      res.writeHead(302, { Location: '/demo/' }).end();
      return;
    }
    if (path.endsWith(sep) || path.endsWith('/')) path = join(path, 'index.html');
    const file = resolve(join(root, path));
    // only serve the source, the demo and the examples, never anything outside them
    if (!allowed.some((dir) => file.startsWith(dir))) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(port, () => console.log(`DRAGON RIFAT AI BOT demo: http://localhost:${port}`));
