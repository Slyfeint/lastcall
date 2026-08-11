/* Renders the app icon in Chrome and saves it at the sizes a PWA needs.
   Chrome is already a dependency of the checks, so this beats hand-rolling a
   PNG encoder or adding an image library.

   node scripts/make-icons.mjs
*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome found.'); process.exit(2); }

const ICON = size => `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Antonio:wght@700&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
  .i{width:${size}px;height:${size}px;background:#241A14;position:relative;
     display:flex;align-items:center;justify-content:center;
     font-family:'Antonio','Arial Narrow',sans-serif;font-weight:700}
  /* the bar-top stripes from the app background, at icon scale */
  .i::before{content:'';position:absolute;inset:0;
     background:repeating-linear-gradient(94deg, rgba(0,0,0,.22) 0 ${size*0.012}px, transparent ${size*0.012}px ${size*0.042}px)}
  .r{position:absolute;inset:${size*0.09}px;border:${size*0.035}px solid #E0A128}
  .t{position:relative;font-size:${size*0.42}px;line-height:1;letter-spacing:-.02em;color:#F2E9DA}
  .t em{font-style:normal;color:#E0A128}
</style>
<div class="i"><div class="r"></div><div class="t">L<em>C</em></div></div>`;

const PORT = 9479;
const profile = mkdtempSync(join(tmpdir(), 'lastcall-icon-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('Chrome never came up'); chrome.kill(); process.exit(2); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
for (const size of [192, 512]) {
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(ICON(size)) });
  await sleep(1400);            // give the webfont a chance; it falls back if offline
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`public/icon-${size}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`public/icon-${size}.png`);
}
ws.close(); chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
