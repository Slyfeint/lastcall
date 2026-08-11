/* What the app costs on a phone with bar wifi, measured rather than assumed.

   Cold cache, 4x CPU throttle, Fast-3G-ish network, a 390x844 viewport. Then
   the same again with the largest deck on the shelf switched on, because the
   interesting question is not the empty case.

   node scripts/perf.mjs [url]
*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome found.'); process.exit(2); }

const SERVE_PORT = 8147, CDP = 9480;
const server = process.argv[2] ? null : spawn(process.execPath, ['scripts/serve.mjs', String(SERVE_PORT)], { stdio: 'ignore' });
const TARGET = process.argv[2] || `http://127.0.0.1:${SERVE_PORT}/`;
const profile = mkdtempSync(join(tmpdir(), 'lastcall-perf-'));
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
if (!ws) { console.error('Chrome never came up'); chrome.kill(); server?.kill(); process.exit(2); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page threw');
  return r.result.result.value;
};

await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setCPUThrottlingRate', { rate: 4 });
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8,
});
await send('Network.setCacheDisabled', { cacheDisabled: true });

// a service worker from an earlier run would hide the cold-cache cost entirely
await send('Page.navigate', { url: TARGET });
await sleep(2500);
await ev(`navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister())))
          .then(()=>caches.keys()).then(ks=>Promise.all(ks.map(k=>caches.delete(k))))`);

async function coldLoad() {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: TARGET });
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    if (await ev(`!!document.querySelector('.tap')`).catch(() => false)) break;
  }
  return ev(`(()=>{
    const n=performance.getEntriesByType('navigation')[0]||{};
    const fcp=(performance.getEntriesByType('paint').find(p=>p.name==='first-contentful-paint')||{}).startTime;
    const bytes=performance.getEntriesByType('resource').reduce((s,r)=>s+(r.transferSize||0),0)+(n.transferSize||0);
    return {
      fcp: Math.round(fcp||0),
      domReady: Math.round(n.domContentLoadedEventEnd||0),
      boardPainted: Math.round(performance.now()),
      requests: performance.getEntriesByType('resource').length,
      kb: Math.round(bytes/1024),
    };
  })()`);
}

const cold = await coldLoad();
console.log('cold load, 4x CPU throttle, ~1.6 Mbps, 390x844');
console.log(`  first paint        ${cold.fcp} ms`);
console.log(`  dom ready          ${cold.domReady} ms`);
console.log(`  board on screen    ${cold.boardPainted} ms`);
console.log(`  over the wire      ${cold.kb} KB in ${cold.requests} requests`);

/* The board paints from the house deck before the manifest lands, and the local
   Jeopardy manifest is merged after the public one — so wait for the count to
   stop moving, not merely to be non-zero. */
for (let i = 0; i < 150; i++) {
  if (await ev('manifestReady===true').catch(() => false)) break;
  await sleep(150);
}
/* DevTools throttling does not reach requests the service worker makes, so a
   deck fetched through it looks instant however slow the connection is. Take
   the worker out before timing the wire. */
await ev(`navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister())))
          .then(()=>caches.keys()).then(ks=>Promise.all(ks.map(k=>caches.delete(k))))`);
const big = await ev(`(()=>{const d=[...MANIFEST].sort((a,b)=>b.count-a.count)[0]; return d?{id:d.id,name:d.name,count:d.count}:null;})()`);
if (big) {
  /* CPU throttling is real here; network throttling is not — DevTools does not
     apply it to fetch() from page script, measured at 112 MB/s against a
     200 KB/s emulated link. So the wire cost is stated as arithmetic from the
     file size, and only the CPU-bound numbers are measured. */
  const t = await ev(`(async()=>{
    const t0=performance.now();
    const raw=await (await fetch(${JSON.stringify('decks/jeopardy/' + big.id + '.json')})).text();
    const fetched=performance.now();
    const cards=JSON.parse(raw).cards;
    const parsed=performance.now();
    S.on=[${JSON.stringify(big.id)}];
    await ensureDecks([${JSON.stringify(big.id)}]);
    const built=performance.now();
    renderBoard();
    return {kb:Math.round(raw.length/1024), parse:Math.round(parsed-fetched),
            build:Math.round(built-parsed), render:Math.round(performance.now()-built),
            cards:DECK.length};
  })()`);
  console.log(`\nheaviest deck: ${big.name} (${big.count.toLocaleString()} cards, ${t.kb} KB)`);
  console.log(`  over a 1.6 Mbps link that is ~${(t.kb / 200).toFixed(1)} s of download (arithmetic, not measured)`);
  console.log(`  parse the json     ${t.parse} ms`);
  console.log(`  rebuild the deck   ${t.build} ms`);
  console.log(`  board redraw       ${t.render} ms`);
  console.log(`  deck now holds     ${t.cards.toLocaleString()} cards`);

  const drill = await ev(`(()=>{const t0=performance.now();
    document.getElementById('btnDrill').click();
    return Math.round(performance.now()-t0);})()`);
  console.log(`  start a drill      ${drill} ms`);
}
await ev('S=DEFAULT(); flush()').catch(() => {});
ws.close(); chrome.kill(); server?.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
