// Run: npm run example:browser   then open http://localhost:8080/examples/embed.html
// Tiny static file server for the embed example (development only).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.css': 'text/css' };
const port = Number(process.env.PORT || 8080);

http
  .createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = resolve(join(root, path === sep || path === '/' ? 'examples/embed.html' : path));
    // only serve the source and the examples, never anything outside them
    if (!(file.startsWith(join(root, 'src') + sep) || file.startsWith(join(root, 'examples') + sep))) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(port, () => console.log(`Open http://localhost:${port}/examples/embed.html`));
