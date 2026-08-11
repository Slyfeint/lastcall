/* A static server for public/, because the app fetches deck files and fetch()
   is blocked on file:// . Twenty lines beats a dependency.

   node scripts/serve.mjs [port]
*/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = +(process.argv[2] || 8080);
const ROOT = 'public';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
                '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';
  // normalize resolves any ../ before it can climb out of public/
  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`));
