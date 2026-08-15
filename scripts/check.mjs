/* Drives a real Chrome over CDP against a real page load.
   The in-page ?selftest covers pure logic; this covers the things only a
   browser can answer — does progress actually come back after a reload.

   node scripts/check.mjs [url]        default: the local file
*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome found.'); process.exit(2); }

/* The app fetches deck files, which file:// forbids, so the local run is served
   over http the same way the deployed one is. */
const SERVE_PORT = 8145;
const server = process.argv[2] ? null : spawn(process.execPath, ['scripts/serve.mjs', String(SERVE_PORT)], { stdio: 'ignore' });
const TARGET = process.argv[2] || `http://127.0.0.1:${SERVE_PORT}/`;
const PORT = 9444;
const profile = mkdtempSync(join(tmpdir(), 'lastcall-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let fails = 0;
const ok = (name, cond) => { if (!cond) fails++; console.log((cond ? 'PASS  ' : 'FAIL  ') + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome never came up on the debugging port');
}

const wsUrl = await connect();
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let msgId = 0;
const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { pending.set(++msgId, r); ws.send(JSON.stringify({ id: msgId, method, params })); });

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page threw');
  return r.result.result.value;
};
const nav = async (url = TARGET) => {
  await send('Page.enable');
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await ev('document.readyState==="complete" && !!document.getElementById("mastStat")').catch(() => false)) break;
  }
  await sleep(250);
};
// pagehide flushes the live page's state over anything written from outside,
// so a clean slate means resetting S itself, not clearing the store
const reset = () => ev('S=DEFAULT(); flush()');
/* A class named "hidden" is not the same as being invisible — CSS gets a vote.
   Ask the layout, not the class list. */
const visible = id => ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
  return !!(e && e.offsetWidth + e.offsetHeight > 0);})()`);

try {
  console.log(`--- ${TARGET}\n`);

  await nav(); await reset(); await nav();
  ok('boot: the built-in deck loaded', await ev('BUILTIN.length > 0'));
  ok('boot: every house category has a tap', await ev('BUILT_CATS.every(c=>document.querySelector(`.tap[data-cat="${c.id}"]`))'));

  // --- progress survives a reload. Nothing else matters until this holds.
  await ev(`document.getElementById('btnDrill').click();
            document.getElementById('btnFlip').click();
            document.querySelector('#gradeRow .g2').click()`);
  const graded = await ev('Object.keys(S.sched)[0]');
  await ev('flush()');
  await nav();
  ok('progress: a graded card is still scheduled after a reload', await ev(`!!S.sched[${JSON.stringify(graded)}]`));
  ok('progress: the all-time counter persisted', await ev('S.answered === 1'));

  // --- schedules are keyed by content, so a rebuilt deck keeps them
  ok('ids: every id is a content hash, not a position', await ev('DECK.every(c=>c.id===cardId(c.q))'));
  ok('ids: the graded card keeps its id across the reload',
     await ev(`DECK.some(c=>c.id===${JSON.stringify(graded)})`));

  // --- the shelf: decks are listed from the manifest and fetched only on demand
  await reset(); await nav();
  ok('shelf: the manifest was read', await ev('MANIFEST.length >= 20'));
  ok('shelf: nothing extra was fetched at boot', await ev('LOADED.size === 0'));
  ok('shelf: areas group the board', await ev('document.querySelectorAll(".area").length >= 5'));
  /* Walks .tap-row, not .tap. renderBoard wraps every row in a .tap-row, so the
     old walk stopped at the first sibling and counted nought for every area on
     the board — it passed on nothing for as long as it existed. Demonstrated:
     with the cap deliberately broken to 20 rows in one area, the old walk still
     said yes and this one says no. */
  ok('shelf: an area never renders more than a dozen rows unasked',
     await ev(`[...document.querySelectorAll('.area')].every(h=>{
       let n=0,el=h.nextElementSibling;
       while(el&&el.classList.contains('tap-row')){n++;el=el.nextElementSibling;}
       return n<=12;          // a literal, not PER_AREA — a check must not read its own answer
     })`));
  ok('shelf: and that walk actually reaches the rows', await ev(`
    [...document.querySelectorAll('.area')].some(h=>
      h.nextElementSibling&&h.nextElementSibling.classList.contains('tap-row'))`));

  /* Folding only kicks in past a dozen decks in one area, which is the local
     Jeopardy build, not the hosted site. Search is checked either way; the
     folding checks say so when there is nothing to fold rather than failing. */
  const hidden = await ev(`(()=>{
    const drawn=new Set([...document.querySelectorAll('.tap')].map(e=>e.dataset.cat));
    const c=CATS.find(x=>!drawn.has(x.id));
    return c?c.name:null;
  })()`);
  const target = hidden || await ev('CATS[CATS.length-1].name');
  await ev(`document.getElementById('deckSearch').value=${JSON.stringify(target.slice(0, 6))};
            document.getElementById('deckSearch').dispatchEvent(new Event('input'))`);
  ok('search: it finds a deck by name', await ev(`[...document.querySelectorAll('.tap-name')].some(e=>e.textContent===${JSON.stringify(target)})`));
  ok('search: and narrows the count', await ev('document.getElementById("searchCount").textContent.includes(" of ")'));
  if (hidden) ok('search: it reaches a deck the board had folded away', true);
  else console.log(`SKIP  folding not exercised — only ${await ev('CATS.length')} categories, none folded`);
  await ev(`document.getElementById('deckSearch').value='zzzznothing';
            document.getElementById('deckSearch').dispatchEvent(new Event('input'))`);
  ok('search: says so when nothing matches', await ev(`document.querySelectorAll('.tap').length===0 && /Nothing matches/.test(document.getElementById('tapList').textContent)`));
  await ev(`document.getElementById('deckSearch').value='';
            document.getElementById('deckSearch').dispatchEvent(new Event('input'))`);
  ok('search: clearing it brings the board back', await ev('document.querySelectorAll(".tap").length > 5'));

  const moreBtn = await ev(`!!document.querySelector('.more')`);
  if (moreBtn) {
    ok('shelf: a folded area offers to show the rest', true);
    const shownBefore = await ev('document.querySelectorAll(".tap").length');
    await ev(`document.querySelector('.more').click()`);
    ok('shelf: showing the rest actually adds rows', await ev(`document.querySelectorAll(".tap").length > ${shownBefore}`));
  } else console.log('SKIP  no area is folded, so there is no "show all" to press');
  const shelfDeck = await ev('MANIFEST.find(d=>d.count>50).id');
  const before = await ev('DECK.length');
  await ev(`document.querySelector('.tap[data-cat=${JSON.stringify(shelfDeck)}]').click()`);
  await sleep(700);
  ok('shelf: switching a deck on fetches it', await ev(`LOADED.has(${JSON.stringify(shelfDeck)})`));
  ok('shelf: its cards joined the deck', await ev(`DECK.length > ${before}`));
  ok('shelf: and its cards carry its category', await ev(`DECK.some(c=>c.c===${JSON.stringify(shelfDeck)})`));
  ok('shelf: the choice is remembered', await ev(`(S.on||[]).includes(${JSON.stringify(shelfDeck)})`));
  await ev('flush()'); await nav();
  ok('shelf: a deck switched on is refetched after a reload', await ev(`LOADED.has(${JSON.stringify(shelfDeck)}) && DECK.length > ${before}`));
  await ev(`document.querySelector('.tap[data-cat=${JSON.stringify(shelfDeck)}]').click()`);
  ok('shelf: switching it off drops it from the drill', await ev(`!activeCats().includes(${JSON.stringify(shelfDeck)})`));

  // --- v1 progress in the wild must migrate on load
  await reset();
  await ev(`localStorage.setItem('lastcall:v1', JSON.stringify({sched:{k7:{ivl:9,ease:2.5,due:0,reps:2,lapses:0}},off:[],lastDay:null,streak:3,answered:11}));
            TESTING=true`);   // stop this page's pagehide from clobbering the seeded blob
  await nav();
  ok('migrate: a v1 blob is re-keyed by hash on load', await ev(`!!S.sched[cardId(BUILTIN[7].q)]`));
  ok('migrate: the schedule itself came through', await ev(`S.sched[cardId(BUILTIN[7].q)]?.[0]===9`));
  ok('migrate: it is packed, not an object', await ev(`Array.isArray(S.sched[cardId(BUILTIN[7].q)]||null)`));
  ok('migrate: unrelated state is untouched', await ev('S.streak===3 && S.answered===11'));

  // --- the board must not get slower as the shelf gets bigger
  await reset(); await nav();
  for (let i = 0; i < 60; i++) { if (await ev('manifestReady===true')) break; await sleep(150); }
  const biggest = await ev(`[...MANIFEST].sort((a,b)=>b.count-a.count)[0]?.count || 0`);
  if (biggest >= 2000) {
    /* Unthrottled, this desktop draws the board in single-digit milliseconds
       whether the code is O(cards) or O(categories x cards) — the budget only
       separates them on something that feels like a phone. */
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const perf = await ev(`(async()=>{
      const d=[...MANIFEST].sort((a,b)=>b.count-a.count)[0];
      S.on=[d.id]; await ensureDecks([d.id]);
      renderBoard();                                  // once to warm up
      const t0=performance.now(); renderBoard(); const draw=performance.now()-t0;
      return {draw:Math.round(draw), cards:DECK.length, cats:CATS.length};
    })()`);
    console.log(`        ${perf.cards.toLocaleString()} cards over ${perf.cats} categories, CPU throttled 4x`);
    ok(`perf: the board redraws in ${perf.draw} ms, under 150`, perf.draw < 150);
    const drill = await ev(`(()=>{const t0=performance.now();
      document.getElementById('btnDrill').click(); return Math.round(performance.now()-t0);})()`);
    ok(`perf: a drill starts in ${drill} ms, under 150`, drill < 150);
    await ev(`document.getElementById('btnQuit').click()`);
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  } else console.log(`SKIP  biggest deck is only ${biggest} cards — build the local Jeopardy decks to exercise this`);
  await reset();

  // --- the form guide
  await reset(); await nav();
  await ev(`document.getElementById('btnStats').click()`);
  ok('stats: it opens', await visible('statsView'));
  ok('stats: readiness is zero before you have drilled anything', await ev(`readiness().pct===0`));
  ok('stats: and says so rather than showing an empty chart',
     await ev(`document.querySelectorAll('#statsBody .empty').length>=3`));
  await ev(`document.getElementById('btnStatsBack').click()`);

  // drill a handful, right and wrong, then read the numbers back
  await ev(`(()=>{ document.getElementById('btnDrill').click();
    for(let i=0;i<8;i++){ if(!flipped) flip(); answer(i<6?2:1); } })()`);
  await ev(`document.getElementById('btnQuit').click(); document.getElementById('btnStats').click()`);
  ok('stats: the session was logged', await ev('(S.hist||[]).length===1'));
  ok('stats: with what was asked and what was right', await ev(`S.hist[0][2]>=8 && S.hist[0][3]===6`));
  ok('stats: per-category accuracy was recorded', await ev(`Object.values(S.acc).reduce((n,a)=>n+a[1],0)>=8`));

  const r = await ev('readiness()');
  ok('stats: readiness counts unseen cards as unknown', r.pct < 100 && r.seen < r.pool);
  ok('stats: and the arithmetic on screen matches the number',
     await ev(`(()=>{const t=document.getElementById('statsBody').textContent;
       const r=readiness();
       return t.includes(r.pool.toLocaleString()) && t.includes(r.seen.toLocaleString())
              && new RegExp('= '+r.pct+'%').test(t);})()`));
  ok('stats: a freshly reviewed card is recalled at about 0.9 after one interval',
     await ev(`(()=>{const id=DECK[0].id; S.sched[id]=[10,2.5,today()+10,3,0];
       const now=recall(id); S.sched[id]=[10,2.5,today(),3,0];
       const due=recall(id); return now===1 && Math.abs(due-0.9)<0.001;})()`));

  ok('stats: the category bars are drawn', await ev(`document.querySelectorAll('#statsBody .mark').length>=1`));
  ok('stats: weakest category first', await ev(`(()=>{
    const vals=[...document.querySelectorAll('#statsBody .mark')].map(m=>+m.getAttribute('width'));
    return vals.every((v,i)=>i===0||vals[i-1]<=v);})()`));
  ok('stats: every mark carries its own tooltip', await ev(`
    [...document.querySelectorAll('#statsBody .mark, #statsBody .cell')].every(m=>m.querySelector('title'))`));
  ok('stats: the heatmap has a square for today', await ev(`
    [...document.querySelectorAll('#statsBody .cell title')].some(t=>t.textContent.includes(new Date(today()*86400000).toISOString().slice(0,10)))`));
  ok('stats: charts are inline svg, not images', await ev(`
    document.querySelectorAll('#statsBody svg').length>=2 && document.querySelectorAll('#statsBody img').length===0`));
  ok('stats: each chart describes itself for a screen reader', await ev(`
    [...document.querySelectorAll('#statsBody svg')].every(s=>(s.getAttribute('aria-label')||'').length>20)`));
  ok('stats: one hue only — no chart invents a second colour', await ev(`(()=>{
    const fills=new Set([...document.querySelectorAll('#statsBody [fill]')].map(e=>e.getAttribute('fill')));
    return [...fills].every(f=>/^var\\(--heat-\\d\\)$/.test(f)||f==='transparent');})()`));

  // a second session with a different shape has to move the line, not the bars only
  await ev(`document.getElementById('btnStatsBack').click();
            (()=>{ document.getElementById('btnRound').click();
              for(let i=0;i<10;i++){ if(!flipped) flip(); answer(1); } })();
            document.getElementById('btnBack').click();
            document.getElementById('btnStats').click()`);
  ok('stats: a round counts toward accuracy too', await ev('(S.hist||[]).length===2'));
  ok('stats: two sessions draw the line', await ev(`!!document.querySelector('#statsBody .line')`));
  ok('stats: but only the drill moved the schedule',
     await ev(`Object.keys(S.sched).length <= 9`));
  await ev(`document.getElementById('btnStatsBack').click()`);

  // --- reachable by keyboard, readable by everyone
  await reset(); await nav();
  const unnamed = await ev(`(()=>{
    const name=el=>(el.getAttribute('aria-label')||el.textContent||el.value||'').trim();
    return [...document.querySelectorAll('button, input, a[href], [tabindex]')]
      .filter(el=>el.offsetWidth+el.offsetHeight>0 && !name(el))
      .map(el=>el.id||el.className||el.tagName);
  })()`);
  ok('a11y: every visible control has a name', unnamed.length === 0);
  if (unnamed.length) console.log('        unnamed: ' + unnamed.join(', '));

  ok('a11y: the category rows say whether they are on', await ev(`
    [...document.querySelectorAll('.tap')].every(e=>e.getAttribute('aria-pressed')!==null)`));
  ok('a11y: the dive buttons name their category', await ev(`
    [...document.querySelectorAll('.dive')].every(e=>/^Dive into .+/.test(e.getAttribute('aria-label')||''))`));
  ok('a11y: the verdict is announced', await ev(`document.getElementById('verdict').getAttribute('aria-live')==='polite'`));
  ok('a11y: areas are headings, so you can jump between them', await ev(`document.querySelectorAll('h2.area').length>0`));
  ok('a11y: focus is visible, not suppressed', await ev(`[...[...document.styleSheets].find(s=>!s.href).cssRules]
      .some(r=>/focus-visible/.test(r.selectorText||'') && /outline/.test(r.style?.cssText||''))`));
  ok('a11y: motion is optional', await ev(`[...[...document.styleSheets].find(s=>!s.href).cssRules]
      .some(r=>/prefers-reduced-motion/.test(r.conditionText||''))`));

  /* Contrast, measured against what is actually painted — and this loop used to
     read less than it claimed. Three things it could not see:
       opacity — .tap.off faded its own text to 2.63:1 and the zero due count to
         1.57:1, both of which read as a comfortable 6.16:1 here
       translucent backgrounds — an rgba() surface was treated as opaque instead
         of composited over what sits behind it
       svg text — it is painted by `fill`, and reading `color` never saw a chart
     A selector that is not on screen now prints SKIP instead of vanishing: the
     old `continue` meant a typo'd selector was indistinguishable from a pass. */
  const contrast = await ev(`(()=>{
    const px=s=>{const m=(s||'').match(/[\\d.]+/g)||[]; return [+m[0]||0,+m[1]||0,+m[2]||0, m[3]===undefined?1:+m[3]];};
    const over=(f,b)=>[f[0]*f[3]+b[0]*(1-f[3]), f[1]*f[3]+b[1]*(1-f[3]), f[2]*f[3]+b[2]*(1-f[3]), 1];
    const lum=c=>{const [r,g,b]=c.slice(0,3).map(v=>{v/=255;
      return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);});
      return .2126*r+.7152*g+.0722*b;};
    const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return (x+.05)/(y+.05);};
    // the colour really behind an element: composite every translucent ancestor
    const bgOf=el=>{
      let out=null;
      for(let n=el;n;n=n.parentElement){
        const c=px(getComputedStyle(n).backgroundColor);
        if(!c[3]) continue;
        out = out ? over(out,c) : c;
        if(c[3]===1) break;
      }
      return out || px(getComputedStyle(document.body).backgroundColor);
    };
    // opacity multiplies down the tree, so a faded row dims its own text
    const opacityOf=el=>{let o=1;
      for(let n=el;n&&n!==document.documentElement;n=n.parentElement) o*=parseFloat(getComputedStyle(n).opacity)||0;
      return o;};
    const out=[];
    for(const sel of ['.tap.on .tap-name','.tap.off .tap-name','.tap.off .tap-style','.tap-style','.tap-pct',
                      '.tap-due.zero','.area-n','.subline','.panel-note','.mast-right','.footnote',
                      'h2.area','.search-count','.dive','.keys','.list-head span']){
      const el=document.querySelector(sel);
      if(!el){ out.push({sel,missing:true}); continue; }
      const cs=getComputedStyle(el);
      const bg=bgOf(el);
      const isSvg=!!(el.namespaceURI&&el.namespaceURI.includes('svg'));
      const raw=px(isSvg?cs.fill:cs.color);
      raw[3]*=opacityOf(el);
      out.push({sel, ratio:+ratio(over(raw,bg),bg).toFixed(2),
                size:parseFloat(cs.fontSize), weight:cs.fontWeight});
    }
    return out;
  })()`);
  for (const c of contrast) {
    if (c.missing) { console.log(`SKIP  a11y: ${c.sel} is not on screen here — not measured`); continue; }
    const large = c.size >= 24 || (c.size >= 18.66 && +c.weight >= 700);
    const need = large ? 3 : 4.5;
    ok(`a11y: ${c.sel} contrast ${c.ratio}:1 clears ${need}:1`, c.ratio >= need);
  }

  // keyboard alone must get you through a card
  await ev(`document.getElementById('btnDrill').click()`);

  /* The three grades must be told apart without a pointer. They used to differ
     only on :hover, which on the device this is played on is never. */
  const grades = await ev(`(()=>{
    /* Each grade's own left border is still the plain rule colour, so it is the
       honest baseline for "did this button get a colour of its own". */
    const g=s=>{const cs=getComputedStyle(document.querySelector(s));
      return {top:cs.borderTopColor, base:cs.borderLeftColor};};
    return {g1:g('#gradeRow .g1'), g2:g('#gradeRow .g2'), g3:g('#gradeRow .g3')};
  })()`);
  ok('design: each grade carries its own colour with no pointer involved',
     new Set([grades.g1.top, grades.g2.top, grades.g3.top]).size === 3);
  ok('design: and none of them is left at the plain rule colour',
     [grades.g1, grades.g2, grades.g3].every(g => g.top !== g.base));
  ok('design: no verdict paints a tint behind its own text', await ev(`
    ['right','close','wrong'].every(k=>{
      const el=document.getElementById('verdict');
      el.className='verdict '+k;
      const bg=getComputedStyle(el).backgroundColor;
      return /rgba\\(0, 0, 0, 0\\)|transparent/.test(bg);
    })`));
  /* Walks into the media rules: checking only the top level passed no matter
     which query wrapped them, which is a check that cannot fail. */
  ok('design: every hover rule sits behind a pointer query', await ev(`(()=>{
    const bad=[];
    const walk=(rules,cond)=>{ for(const r of rules){
      if(r.type===CSSRule.MEDIA_RULE) walk(r.cssRules, cond+' '+r.conditionText);
      else if(r.type===CSSRule.STYLE_RULE && /:hover/.test(r.selectorText||'')
              && !/hover\\s*:\\s*hover/.test(cond)) bad.push(r.selectorText);
    }};
    walk([...document.styleSheets].find(s=>!s.href).cssRules,'');
    window.__ungated=bad;
    return bad.length===0;
  })()`));
  ok('keys: space flips the card', await ev(`
    document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true})); flipped===true`));
  ok('keys: a number grades it', await ev(`
    const before=S.answered||0;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'2',bubbles:true}));
    (S.answered||0)===before+1`));
  ok('keys: escape leaves the session', await ev(`
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    document.getElementById('board').classList.contains('live')`));

  // --- installable, and usable with the wifi off
  await reset(); await nav();
  ok('pwa: the manifest is linked', await ev(`!!document.querySelector('link[rel=manifest]')`));
  const mf = await ev(`fetch('manifest.webmanifest').then(r=>r.ok?r.json():null)`);
  ok('pwa: the manifest is served and parses', !!mf);
  ok('pwa: it is standalone with a name and a start url', mf?.display === 'standalone' && !!mf?.name && !!mf?.start_url);
  ok('pwa: it offers a 192 and a 512 icon', ['192x192', '512x512'].every(s => mf?.icons?.some(i => i.sizes === s)));
  ok('pwa: one icon is maskable', mf?.icons?.some(i => (i.purpose || '').includes('maskable')));
  for (const f of ['icon-192.png', 'icon-512.png']) {
    ok(`pwa: ${f} is really there`, await ev(`fetch('${f}').then(r=>r.ok&&r.headers.get('content-type')==='image/png')`));
  }

  ok('pwa: the service worker registers', await ev(`navigator.serviceWorker.register('sw.js').then(()=>true,()=>false)`));
  await ev(`navigator.serviceWorker.ready.then(()=>true)`);
  // load a deck so it is in the cache, then reload to be sure the worker is driving
  const offlineDeck = await ev('MANIFEST[0].id');
  await ev(`document.querySelector('.tap[data-cat=${JSON.stringify(offlineDeck)}]').click()`);
  await sleep(800);
  await ev('flush()');
  await nav(); await sleep(600);

  await send('Network.enable');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await nav();
  ok('offline: the app still loads with the network cut', await ev(`!!document.getElementById('mastStat')`));
  // defensive: if the page failed to load at all these must report, not throw
  ok('offline: the house deck is there', await ev(`typeof BUILTIN!=='undefined' && BUILTIN.length>0`));
  ok('offline: a deck you had opened is still there',
     await ev(`typeof LOADED!=='undefined' && LOADED.has(${JSON.stringify(offlineDeck)}) && DECK.some(c=>c.c===${JSON.stringify(offlineDeck)})`));
  await ev(`(()=>{ try{ document.getElementById('btnDrill').click(); flip(); answer(2); }catch(e){} })()`);
  ok('offline: you can still drill and it still counts', await ev(`typeof S!=='undefined' && S.answered>=1`));
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await nav();
  await ev(`navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister())))`);
  await ev(`caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k))))`);

  // --- the board game
  await reset(); await nav();
  await ev(`document.getElementById('btnBoardGame').click()`);
  ok('quiz: the grid appears', await visible('quizView'));
  ok('quiz: six categories across', await ev('quiz.cats.length===6'));
  ok('quiz: five clues down each', await ev('quiz.cats.every(c=>c.cards.length===5)'));
  ok('quiz: no clue is used twice on one board',
     await ev('new Set(quiz.cats.flatMap(c=>c.cards)).size===30'));
  ok('quiz: the cheap clues really are the easier ones',
     await ev(`quiz.cats.every(c=>{const d=c.cards.map(id=>BY_ID[id].d||2);
       return d.every((x,i)=>i===0||d[i-1]<=x);})`));
  ok('quiz: thirty tiles on the board', await ev(`document.querySelectorAll('.tile').length===30`));
  ok('quiz: the score starts at nothing', await ev(`document.getElementById('quizScore').textContent==='$0'`));

  const schedBefore = await ev('JSON.stringify(S.sched)');
  await ev(`document.querySelector('.tile[data-cell="0:0"]').click()`);
  ok('quiz: picking a tile shows the clue', await visible('stage'));
  ok('quiz: labelled with its category and value',
     await ev(`/\\$200$/.test(document.getElementById('cardCat').textContent)`));
  await ev(`flip(); answer(1)`);
  ok('quiz: a right answer pays its value', await ev(`quiz.score===200`));
  ok('quiz: and returns to the grid', await visible('quizView'));
  ok('quiz: the tile is spent', await ev(`document.querySelector('.tile[data-cell="0:0"]').disabled===true`));

  await ev(`document.querySelector('.tile[data-cell="1:4"]').click(); flip(); answer(0)`);
  ok('quiz: a wrong answer costs its value, like the show', await ev(`quiz.score===200-1000`));
  ok('quiz: a negative score reads as negative', await ev(`document.getElementById('quizScore').textContent==='-$800'`));

  ok('quiz: it is a game, so it leaves your schedule alone', await ev('JSON.stringify(S.sched)') === schedBefore);

  // clear the rest of the board and it should finish on its own
  await ev(`(()=>{ for(let col=0;col<quiz.cats.length;col++) for(let row=0;row<5;row++){
      const el=document.querySelector('.tile[data-cell="'+col+':'+row+'"]');
      if(el && !el.disabled){ el.click(); flip(); answer(1); }
    } })()`);
  ok('quiz: clearing the board ends it', await visible('resultView'));
  ok('quiz: with the money on screen', await ev(`/^-?\\$[\\d,]+$/.test(document.getElementById('scoreNum').textContent)`));

  // --- the wager
  await reset(); await nav();
  await ev(`document.getElementById('btnBoardGame').click();
            (()=>{ for(let col=0;col<quiz.cats.length;col++) for(let row=0;row<5;row++){
              const el=document.querySelector('.tile[data-cell="'+col+':'+row+'"]');
              if(el && !el.disabled){ el.click(); flip(); answer(1); } } })()`);
  ok('wager: a winning board offers one', await visible('wagerBox'));
  ok('wager: prefilled with everything you have', await ev(`+document.getElementById('wagerAmount').value===quiz.score`));
  const bank = await ev('quiz.score');
  await ev(`document.getElementById('wagerAmount').value=${bank * 3};
            document.getElementById('btnWager').click()`);
  ok('wager: you cannot bet more than you hold', await ev(`quiz.bet===${bank}`));
  ok('wager: it deals one more clue', await visible('stage'));
  ok('wager: labelled as the wager', await ev(`/wager/i.test(document.getElementById('cardCat').textContent)`));
  ok('wager: on a clue the board did not already use',
     await ev(`!new Set(quiz.cats.flatMap(c=>c.cards)).has(Q[0])`));
  await ev(`flip(); answer(0)`);
  ok('wager: losing it costs the bet', await ev(`quiz.score===0`));
  ok('wager: and it is not offered twice', !(await visible('wagerBox')));

  // --- the table: the same board, dealt to friends
  await reset(); await nav();
  // an escaped session logs itself — otherwise its tally leaks into whatever logs next
  await ev(`document.getElementById('btnRound').click();
            (()=>{ for(let i=0;i<2;i++){ if(!flipped) flip(); answer(1); } })();
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  ok('table: an escaped round logs its own session', await ev(`(S.hist||[]).length===1 && S.hist[0][2]===2`));

  await ev(`document.getElementById('btnBoardGame').click()`);
  ok('table: a fresh board offers seats', await visible('seatRow'));
  await ev(`document.getElementById('quizSeats').value='Sam';
            document.getElementById('btnDeal').click()`);
  ok('table: one name is not a table, and it says so',
     await ev(`!quiz.players && /at least two names/.test(document.getElementById('seatMsg').textContent)`));
  await ev(`document.getElementById('quizSeats').value='Sam, Sam, Ann, Ben, Cal, Dee, Eli';
            document.getElementById('btnDeal').click()`);
  ok('table: two Sams both keep a seat', await ev(`quiz.players.some(p=>p.name==='Sam') && quiz.players.some(p=>p.name==='Sam 2')`));
  ok('table: six seats at a table, and it says so',
     await ev(`quiz.players.length===6 && /Six seats/.test(document.getElementById('seatMsg').textContent)`));
  await ev(`document.getElementById('quizSeats').value='Alice, Bob';
            document.getElementById('btnDeal').click()`);
  ok('table: dealing two names makes it hot-seat', await ev('quiz.players?.length===2 && quiz.turn===0'));
  ok('table: the solo score makes way for the scoreboard',
     !(await visible('quizScore')) && await ev(`document.querySelectorAll('#quizPlayers .pl').length===2`));
  ok('table: exactly one seat is marked as having the turn',
     await ev(`document.querySelectorAll('#quizPlayers .pl[aria-current]').length===1`));
  ok('table: the names are remembered for next time', await ev(`S.names==='Alice, Bob'`));
  const unnamedQuiz = await ev(`(()=>{
    const name=el=>(el.getAttribute('aria-label')||el.textContent||el.value||el.placeholder||'').trim();
    return [...document.querySelectorAll('#quizView button, #quizView input')]
      .filter(el=>el.offsetWidth+el.offsetHeight>0 && !name(el)).length;
  })()`);
  ok('table: every control on the table screen has a name', unnamedQuiz === 0);

  const accBefore = await ev('JSON.stringify(S.acc)');
  const histBefore = await ev('JSON.stringify(S.hist)');
  await ev(`document.querySelector('.tile[data-cell="0:0"]').click()`);
  ok('table: the clue says whose turn it is', await ev(`document.getElementById('cardCat').textContent.startsWith('Alice · ')`));
  await ev(`flip(); answer(1)`);
  ok('table: a right answer pays that seat', await ev('quiz.players[0].score===200'));
  ok('table: and the turn passes', await ev('quiz.turn===1'));
  ok('table: the pass is announced for a screen reader',
     await ev(`/Alice won \\$200.*Bob to pick/.test(document.getElementById('turnStatus').textContent)`));
  ok('table: once play starts the seats row is gone', !(await visible('seatRow')));
  await ev(`document.querySelector('.tile[data-cell="1:4"]').click(); flip(); answer(0)`);
  ok('table: a miss costs the seat that missed', await ev('quiz.players[1].score===-1000'));
  ok('table: other people’s answers stay out of your form', await ev('JSON.stringify(S.acc)') === accBefore);

  await ev(`document.getElementById('btnQuizDone').click()`);
  ok('table: the standings name the winner', await ev(`/Alice takes the night/.test(document.getElementById('scoreLine').textContent)`));
  ok('table: every seat is on the scorecard', await ev(`document.querySelectorAll('#missedList li').length===2`));
  ok('table: red money is legible, not amber', await ev(`!!document.querySelector('#missedList b.neg')`));
  ok('table: the game lands on the record, scores and all',
     await ev(`(S.games||[]).length===1 && S.games[0][1].join()==='Alice,Bob' && S.games[0][2].join()==='200,-1000'`));
  ok('table: and your personal history never noticed', await ev('JSON.stringify(S.hist)') === histBefore);

  // the record has to survive a reload, or it is not a record
  await ev('flush()'); await nav();
  ok('table: the record survives a reload', await ev(`(S.games||[]).length===1 && S.games[0][2].join()==='200,-1000'`));
  await ev(`document.getElementById('btnBoardGame').click()`);
  ok('table: the seats remember who was here', await ev(`document.getElementById('quizSeats').value==='Alice, Bob'`));

  // names typed but never "dealt" still count when the first tile is picked
  await ev(`(()=>{ const i=document.getElementById('quizSeats');
    i.value='Cara, Dan'; i.dispatchEvent(new Event('input')); })();
    document.querySelector('.tile[data-cell="0:0"]').click()`);
  ok('table: names typed but never dealt still count', await ev(`quiz.players?.length===2 && quiz.players[0].name==='Cara'`));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await ev(`document.getElementById('btnQuizDone').click()`);
  ok('table: an unplayed board is not a game on the record', await ev('(S.games||[]).length===1'));
  ok('table: an even table splits the night', await ev(`/Cara and Dan split the night/.test(document.getElementById('scoreLine').textContent)`));

  // a full clear has to end the game on its own — and still offer no wager
  await ev(`document.getElementById('btnAgain').click()`);
  ok('table: another board keeps the same table, back at nothing',
     await ev('quiz.players?.length===2 && quiz.players.every(p=>p.score===0) && quiz.spent.size===0'));
  await ev(`(()=>{ for(let col=0;col<quiz.cats.length;col++) for(let row=0;row<5;row++){
      const el=document.querySelector('.tile[data-cell="'+col+':'+row+'"]');
      if(el && !el.disabled){ el.click(); flip(); answer(1); }
    } })()`);
  ok('table: clearing the board ends it on its own', await visible('resultView'));
  ok('table: a cleared table board still offers no wager', !(await visible('wagerBox')));
  ok('table: the cleared board is on the record', await ev('(S.games||[]).length===2'));
  ok('table: finishing twice cannot log twice', await ev('finishQuiz(); (S.games||[]).length===2'));

  // the record is capped, oldest games first out the door
  await ev(`S.games=Array.from({length:120},(_,i)=>[today(),['X','Y'],[i,0]]);
            document.getElementById('btnAgain').click()`);
  await ev(`document.querySelector('.tile[data-cell="0:0"]').click(); flip(); answer(1);
            document.getElementById('btnQuizDone').click()`);
  ok('table: the record stays capped at 120 games',
     await ev(`S.games.length===120 && S.games[119][1].join()==='Cara,Dan' && S.games[0][2][0]===1`));

  await ev(`document.getElementById('btnBack').click(); document.getElementById('btnStats').click()`);
  ok('table: the form guide shows the table’s record',
     await ev(`/Cara/.test(document.getElementById('statsBody').textContent) && /won \\d+ of \\d+/.test(document.getElementById('statsBody').textContent)`));
  await ev(`document.getElementById('btnStatsBack').click()`);
  await ev(`document.getElementById('quizSeats')&&0; document.getElementById('btnBoardGame').click()`);
  ok('table: the plain board game is still solo', await ev('!quiz.players'));
  await ev(`document.getElementById('btnQuizDone').click(); document.getElementById('btnBack').click()`);

  // a backup carries the table's record — and drops rows that are not games
  await reset(); await nav();
  await ev(`(async()=>{
    const f=new File([JSON.stringify({sched:{},games:[
      [today(),['Zed','Quinn'],[600,-200]], ['junk'], [today(),['A'],[1,2]]
    ]})],'b.json',{type:'application/json'});
    const dt=new DataTransfer(); dt.items.add(f);
    const inp=document.getElementById('fileImport');
    Object.defineProperty(inp,'files',{value:dt.files,configurable:true});
    inp.dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,150));
  })()`);
  ok('restore: the table’s record rides along in a backup',
     await ev(`(S.games||[]).length===1 && S.games[0][1].join()==='Zed,Quinn'`));
  ok('restore: rows that are not games are dropped at the door', await ev('(S.games||[]).length===1'));
  await ev(`document.getElementById('btnStats').click()`);
  ok('restore: the restored record reads back in the form guide',
     await ev(`/Zed/.test(document.getElementById('statsBody').textContent)`));
  await ev(`document.getElementById('btnStatsBack').click()`);

  // --- the whole night
  await reset(); await nav();
  await ev(`document.getElementById('btnNight').click()`);
  ok('night: it starts on round one', await ev('night.round===0 && Q.length===10'));
  const playRound = `(()=>{ while(document.getElementById('stage').classList.contains('live')){
      if(!flipped) flip(); answer(1); } })()`;
  await ev(playRound);
  ok('night: a finished round shows the scorecard', await visible('resultView'));
  ok('night: the round is banked', await ev('night.scores.length===1 && night.scores[0]===10'));
  ok('night: and it says how many are left', await ev(`/5 to go/.test(document.getElementById('scoreLine').textContent)`));
  ok('night: the button offers the next round', await ev(`document.getElementById('btnAgain').textContent==='Next round'`));
  for (let i = 0; i < 5; i++) { await ev(`document.getElementById('btnAgain').click()`); await ev(playRound); }
  ok('night: six rounds and it is over', await ev(`night.round===6 && night.scores.length===6`));
  ok('night: totalled out of sixty', await ev(`/60/.test(document.getElementById('scoreNum').textContent)`));
  ok('night: every round is listed', await ev(`document.querySelectorAll('#missedList li').length===6`));
  ok('night: and it offers another night', await ev(`document.getElementById('btnAgain').textContent==='Play another night'`));
  await ev(`document.getElementById('btnBack').click(); document.getElementById('btnRound').click()`);
  ok('night: a plain round afterwards is not part of a night', await ev('night===null'));

  // --- rabbit holes
  await reset(); await nav();
  const diveId = await ev(`MANIFEST.find(d=>d.count>50).id`);
  const onBefore = await ev('JSON.stringify(S.on||[])');
  await ev(`document.querySelector('.dive[data-dive=${JSON.stringify(diveId)}]').click()`);
  await sleep(900);
  ok('dive: it starts a session', await visible('stage'));
  ok('dive: on a deck it had to fetch first', await ev(`LOADED.has(${JSON.stringify(diveId)})`));
  ok('dive: every card in the queue is from that one category',
     await ev(`Q.every(id=>BY_ID[id].c===${JSON.stringify(diveId)})`));
  ok('dive: it did not change what is switched on for tonight', await ev('JSON.stringify(S.on||[])') === onBefore);

  // the hole has no bottom: exhaust the queue and it refills
  const qLen = await ev('Q.length');
  await ev(`(()=>{ for(let i=0;i<${qLen + 3};i++){ if(!flipped) flip(); answer(2); } })()`);
  ok('dive: the queue refills instead of ending', await visible('stage'));
  ok('dive: and stays in the same category', await ev(`Q.every(id=>BY_ID[id].c===${JSON.stringify(diveId)})`));

  // keeping a card copies it somewhere a rebuilt deck cannot reach
  const keptQ = await ev(`BY_ID[Q[idx]]?.q ?? null`);   // null if the refill above failed, so the rest still reports
  await ev(`document.getElementById('btnKeep').click()`);
  ok('keep: the card is copied into your own cards', await ev(`(S.user||[]).some(u=>u.q===${JSON.stringify(keptQ)})`));
  await ev(`document.getElementById('btnKeep').click()`);
  ok('keep: pressing it twice does not duplicate', await ev(`(S.user||[]).filter(u=>u.q===${JSON.stringify(keptQ)}).length===1`));
  await ev(`document.getElementById('btnQuit').click(); flush()`);
  await nav();
  ok('keep: it survives a reload', await ev(`(S.user||[]).some(u=>u.q===${JSON.stringify(keptQ)})`));
  ok('keep: under a category of its own', await ev(`CATS.some(c=>c.id==='u:kept')`));

  // an ordinary drill must not inherit the endless behaviour
  await reset(); await nav();
  await ev(`document.getElementById('btnDrill').click()`);
  ok('drill: a normal session is not a rabbit hole', await ev('diveCat===null'));

  // --- typing the answer
  await reset(); await nav();
  ok('typed: off by default, the flip button is what you get', await ev(`!document.getElementById('flipRow').classList.contains('hidden')`));
  await ev(`document.getElementById('btnTyped').click()`);
  ok('typed: the toggle reports itself pressed', await ev(`document.getElementById('btnTyped').getAttribute('aria-pressed')==='true'`));
  await ev(`document.getElementById('btnDrill').click()`);
  ok('typed: the drill asks for an answer instead of a flip',
     await ev(`!document.getElementById('typeRow').classList.contains('hidden') && document.getElementById('flipRow').classList.contains('hidden')`));
  ok('typed: the box has focus, so you can just type', await ev(`document.activeElement===document.getElementById('typed')`));

  // space belongs in the answer, not on the flip button
  await ev(`document.getElementById('typed').focus();
            document.getElementById('typed').value='new york';
            document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}))`);
  ok('typed: space does not flip the card out from under you', await ev(`!flipped`));

  const right = await ev(`(()=>{
    const c=BY_ID[Q[idx]];
    const t=document.getElementById('typed');
    t.value=c.a; t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    return document.getElementById('verdict').className;
  })()`);
  ok('typed: the exact answer reads as right', /right/.test(right));
  ok('typed: the card is revealed either way', await visible('aWrap'));
  ok('typed: it still asks you to grade it', await visible('gradeRow'));
  // the class said hidden while CSS rendered it anyway, so measure the layout
  ok('typed: the answer box is gone once the card is revealed', !(await visible('typeRow')));
  ok('typed: only one grade row is on screen at a time', !(await visible('roundRow')));
  ok('typed: with "got it" preselected', await ev(`document.activeElement===document.querySelector('#gradeRow .g2')`));

  await ev(`document.querySelector('#gradeRow .g2').click()`);
  const wrong = await ev(`(()=>{
    const t=document.getElementById('typed');
    t.value='definitely not the answer';
    t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    return document.getElementById('verdict').className;
  })()`);
  ok('typed: nonsense reads as wrong', /wrong/.test(wrong));
  ok('typed: and lands on "missed"', await ev(`document.activeElement===document.querySelector('#gradeRow .g1')`));
  await ev(`document.getElementById('btnQuit').click(); flush()`);
  await nav();
  ok('typed: the preference is remembered', await ev('S.typed===true'));
  await ev(`document.getElementById('btnTyped').click(); flush()`);

  // --- hand-added cards
  await reset(); await nav();
  await ev(`document.getElementById('tsv').value="Local\\tWhich street is the brewery on\\tMill Street\\tasked every third week\\r\\nMusic Before 1980\\tWho played bass for the Jam\\tBruce Foxton\\r\\njunk\\r\\n";
            document.getElementById('btnImport').click()`);
  ok('cards: two rows parsed, junk dropped', /Added 2 cards/.test(await ev(`document.getElementById('ioMsg').textContent`)));
  ok('cards: an unknown category becomes its own tap', await ev(`[...document.querySelectorAll('.tap-name')].some(e=>e.textContent==='Local')`));
  ok('cards: a known category absorbs the card', await ev(`DECK.filter(c=>c.c==='mus').length===BUILTIN.filter(c=>c.c==='mus').length+1`));
  await ev('flush()'); await nav();
  ok('cards: hand-added cards survive a reload', await ev('(S.user||[]).length===2'));
  await ev(`window.confirm=()=>true; document.getElementById('btnReset').click()`);
  ok('cards: clearing progress keeps them', await ev('(S.user||[]).length===2 && Object.keys(S.sched).length===0'));

  // --- ?selftest must not write over real progress when its tab goes away
  await reset(); await nav();
  await ev(`document.getElementById('btnDrill').click();
            document.getElementById('btnFlip').click();
            document.querySelector('#gradeRow .g2').click()`);
  await ev('flush()');
  const real = await ev(`localStorage.getItem('lastcall:v1')`);
  await nav(TARGET + '?selftest');
  const suite = await ev(`document.body.innerText`);
  ok('selftest: the in-page suite passes', /all \d+ passed/.test(suite));
  await nav();
  ok('selftest: it left real progress alone', await ev(`localStorage.getItem('lastcall:v1')`) === real);

  await reset();
} catch (err) {
  fails++;
  console.log('FAIL  harness threw: ' + err.message);
} finally {
  ws.close();
  chrome.kill();
  server?.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fails ? fails + ' FAILED' : 'all checks passed'}`);
process.exit(fails ? 1 : 0);
