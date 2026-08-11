/* Screenshot the app, optionally after running something in the page.
   Green checks say the mechanics work; only pixels say the board is readable.

   node scripts/shot.mjs out.png [width] [height] ["js to run first"]
*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [out = 'shot.png', w = '1100', h = '1400', pre = ''] = process.argv.slice(2);
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome found.'); process.exit(2); }

const SERVE_PORT = 8146, CDP = 9478;
const server = spawn(process.execPath, ['scripts/serve.mjs', String(SERVE_PORT)], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'lastcall-shot-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('Chrome never came up'); chrome.kill(); server.kill(); process.exit(2); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;

await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 500 });
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${SERVE_PORT}/` });
await sleep(2600);
if (pre) { console.log(await ev(pre)); await sleep(700); }
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
await ev('S=DEFAULT(); flush()');   // leave no state behind
console.log(`wrote ${out} at ${w}x${h}`);
ws.close(); chrome.kill(); server.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
