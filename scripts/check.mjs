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
/* pagehide flushes the live page's state over anything written from outside,
   so a clean slate means resetting S itself, not clearing the store. The look
   is the one thing that is not in S, and the sweep below changes it sixteen
   times — left behind, a preset chosen by one assertion is what every section
   under it gets measured in. */
const reset = () => ev('S=DEFAULT(); flush(); localStorage.removeItem(LOOK_KEY)');
/* A class named "hidden" is not the same as being invisible — CSS gets a vote.
   Ask the layout, not the class list. */
const visible = id => ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)});
  return !!(e && e.offsetWidth + e.offsetHeight > 0);})()`);

try {
  console.log(`--- ${TARGET}\n`);

  await nav();
  /* Only setLook() writes, and only from a change handler, so a phone nobody
     has touched carries no look key at all. Asserted here and nowhere else:
     reset() removes the key, so anywhere below this it would be reading its own
     answer. Demonstrated by moving the setItem into the head applier so it
     writes back whatever it read — the key appears on a fresh install. */
  ok('look: a fresh install has written nothing', await ev(`localStorage.getItem(LOOK_KEY)===null`));
  await reset(); await nav();
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
    const vals=[...document.querySelectorAll('#statsBody .mark')].map(m=>+m.dataset.pct);
    return vals.every((v,i)=>i===0||vals[i-1]<=v);})()`));
  /* The bars are text now, so the numbers are content a screen reader reads
     rather than a tooltip bolted onto a rectangle. The heatmap is still a
     drawing and still has to caption every square. */
  ok('stats: every bar states its own numbers in text', await ev(`
    [...document.querySelectorAll('#statsBody .bar-row')].every(r=>/\\d+% · \\d+ asked/.test(r.textContent))`));
  ok('stats: every square of the heatmap carries its own tooltip', await ev(`
    [...document.querySelectorAll('#statsBody .cell')].every(m=>m.querySelector('title'))`));
  ok('stats: the heatmap has a square for today', await ev(`
    [...document.querySelectorAll('#statsBody .cell title')].some(t=>t.textContent.includes(new Date(today()*86400000).toISOString().slice(0,10)))`));
  ok('stats: what is drawn is inline svg, not images', await ev(`
    document.querySelectorAll('#statsBody svg').length>=1 && document.querySelectorAll('#statsBody img').length===0`));
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
  // only now are both drawings on screen — before the second session there is no line to draw
  ok('stats: and both drawings are inline svg', await ev(`
    document.querySelectorAll('#statsBody svg').length>=2 && document.querySelectorAll('#statsBody img').length===0`));
  ok('stats: but only the drill moved the schedule',
     await ev(`Object.keys(S.sched).length <= 9`));
  await ev(`document.getElementById('btnStatsBack').click()`);

  // --- reachable by keyboard, readable by everyone
  await reset(); await nav();
  /* The settings panel is a <details>, and a closed one measures nothing — both
     the name check below and the contrast sweep skip anything with no size, so
     every control in it would be quietly uncovered rather than passed. This
     open is load-bearing for both of them, not decoration. */
  await ev(`document.getElementById('setDrawer').open=true`);
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
  /* A dropdown's textContent is every option glued together, so the name check
     above passes it whatever you do. Only a label says what it sets.
     Demonstrated by dropping the for= off one <label>. */
  ok('a11y: every dropdown says what it sets', await ev(`
    [...document.querySelectorAll('select')].every(s=>!!(s.getAttribute('aria-label')
      || document.querySelector('label[for='+JSON.stringify(s.id)+']')))`));
  ok('a11y: the verdict is announced', await ev(`document.getElementById('verdict').getAttribute('aria-live')==='polite'`));
  ok('a11y: areas are headings, so you can jump between them', await ev(`document.querySelectorAll('h2.area').length>0`));
  ok('a11y: focus is visible, not suppressed', await ev(`[...[...document.styleSheets].find(s=>!s.href).cssRules]
      .some(r=>/focus-visible/.test(r.selectorText||'') && /outline/.test(r.style?.cssText||''))`));
  ok('a11y: motion is optional', await ev(`[...[...document.styleSheets].find(s=>!s.href).cssRules]
      .some(r=>/prefers-reduced-motion/.test(r.conditionText||''))`));

  /* Contrast, measured against what is actually painted — and the backdrop is
     now read off the screen, not computed. getComputedStyle().backgroundColor
     is blind to background-image, and body carries two gradient layers: a
     --glow radial ellipse and a --grain repeating-linear-gradient. Both
     propagate to the canvas, where the positioning area is the root box —
     100% of the viewport — so the pair repeats down the whole document and the
     colour behind a body-backed element is never plain --walnut. Composited up
     the ancestor chain, --copper on the board read 4.61:1 and passed; the
     painted answer is lower. Same shape as the incident below: 6.16 measured,
     2.63 painted.

     So the element's own ink is turned transparent, Page.captureScreenshot
     takes the viewport, and the backdrop is sampled out of those pixels — every
     gradient, every translucent ancestor, already flattened by the renderer.
     Only the background changes hands. The foreground is still the computed
     colour composited through the accumulated opacity, because that is text: it
     is what the ink would be, and the screenshot has no way to hand back a
     glyph's colour separately from what it was painted over.

     What the sampling has to catch, and how:
       the glyphs, not the column — a Range over the contents gives the line
         boxes, so a full-width block is measured where its text actually is
       the grain — 2 dark px of every 7, so eight consecutive px per band
       the glow — strongest at the top centre and falling off both ways, so
         three bands across the width and three rows down each line box
       the worst of them, not the average: grain darkens and helps light ink,
         glow lightens and hurts it, and a ratio is only as good as its floor.
     querySelector's first match is kept deliberately — for every body-backed
     selector that is the topmost one, which is the most glow it ever gets.

     The mapping from CSS pixels to image pixels is asserted rather than assumed
     (below, on .btn-go): get the scale wrong and every sample lands somewhere
     else, which is almost always plain walnut — that is to say, it all passes.
     captureBeyondViewport was rejected for the same reason: it re-lays out the
     page 15px narrower to drop the scrollbar, so the rects no longer describe
     the image.

     Three things a computed backdrop could not see either, all still covered:
       opacity — .tap.off faded its own text to 2.63:1 and the zero due count to
         1.57:1, both of which read as a comfortable 6.16:1 here
       translucent backgrounds — an rgba() surface was treated as opaque instead
         of composited over what sits behind it
       svg text — it is painted by `fill`, and reading `color` never saw a chart
     A selector that is not on screen prints SKIP instead of vanishing: the old
     `continue` meant a typo'd selector was indistinguishable from a pass.

     And it is measured once per preset, not once. Every colour below is a token
     a preset redefines, so a theme that ships at 2.6:1 is exactly the bug the
     compositing above was written to catch — and it would have gone out
     unmeasured on every theme but the one that happens to boot. The registry is
     enumerated from the page with a literal count beside it: renamed, the loop
     runs nought times and prints nothing, which reads exactly like a pass. The
     text step is forced back to the default, because the threshold is
     size-dependent and a large step can push a marginal selector past 24px and
     quietly relax it from 4.5 to 3. */
  const presets = await ev(`typeof THEMES!=='undefined' ? Object.keys(THEMES) : []`);
  ok('a11y: every shipped preset gets measured, not just the one that boots', presets.length === 4);
  /* The last four are states nobody reaches by sitting on the board — a row
     mid-load and the two disabled buttons — so __stage switches them on.
     .btn-go just before them is the enabled button: the one place --on-amber is
     painted on --amber, and a flat opaque fill for the mapping assertion. */
  const SELS = ['.tap.on .tap-name','.tap.off .tap-name','.tap.off .tap-style','.tap-style','.tap-pct',
                '.tap-due.zero','.tap-due small','.area-n','.subline','.panel-note','.mast-right','.footnote',
                'h2.area','.search-count','.dive','.keys','.list-head span','.eyebrow','.first-run',
                '.shelf-note','.more','.reset','.drawer summary','.drawer select','.btn-go',
                '.tap.busy .tap-name','.tap.busy .tap-pct','.btn:disabled','.btn-go:disabled'];
  await ev(`(()=>{
    const px=s=>{const m=(s||'').match(/[\\d.]+/g)||[]; return [+m[0]||0,+m[1]||0,+m[2]||0, m[3]===undefined?1:+m[3]];};
    const over=(f,b)=>[f[0]*f[3]+b[0]*(1-f[3]), f[1]*f[3]+b[1]*(1-f[3]), f[2]*f[3]+b[2]*(1-f[3]), 1];
    const lum=c=>{const [r,g,b]=c.slice(0,3).map(v=>{v/=255;
      return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);});
      return .2126*r+.7152*g+.0722*b;};
    const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return (x+.05)/(y+.05);};
    // opacity multiplies down the tree, so a faded row dims its own text
    const opacityOf=el=>{let o=1;
      for(let n=el;n&&n!==document.documentElement;n=n.parentElement) o*=parseFloat(getComputedStyle(n).opacity)||0;
      return o;};
    const hex=c=>'#'+c.slice(0,3).map(v=>Math.round(v).toString(16).padStart(2,'0')).join('').toUpperCase();
    let img=null, scale=1;
    const at=(x,y)=>{ x=Math.round(x*scale); y=Math.round(y*scale);
      if(x<0||y<0||x>=img.width||y>=img.height) return null;
      const i=(y*img.width+x)*4; return [img.data[i],img.data[i+1],img.data[i+2],1]; };
    const load=src=>new Promise(r=>{const i=new Image(); i.onload=()=>{
      const c=document.createElement('canvas'); c.width=i.width; c.height=i.height;
      const g=c.getContext('2d'); g.drawImage(i,0,0);
      img=g.getImageData(0,0,i.width,i.height); scale=i.width/innerWidth; r(); };
      i.src='data:image/png;base64,'+src;});
    let undo=[];
    window.__stage=sels=>{
      /* First, or every number below is read off a frame mid-fade. .btn carries
         a .14s transition on background, colour and border-colour, so switching
         preset starts a fade, disabling a button starts another, and turning
         the ink transparent starts a third — the colour read here and the pixel
         in the screenshot a moment later then come from different frames of it.
         Setting transition:none cancels a running one onto its target value, so
         this settles the page rather than waiting a guessed number of
         milliseconds for it. Same rule the app ships under prefers-reduced-
         motion, and it stops @keyframes pulse mid-sweep for the same reason. */
      document.head.insertAdjacentHTML('beforeend',
        '<style id="noMotion">*{transition:none!important;animation:none!important}</style>');
      undo.push(()=>document.getElementById('noMotion').remove());
      /* Four states nothing on the board reaches on its own. A screenshot can
         only read what is painted, so a state that is never on screen is a
         state nobody measures — .tap.busy and both disabled buttons went out
         unread on every preset until they were switched on here. */
      const row=document.querySelector('.tap');
      if(row){ row.classList.add('busy'); undo.push(()=>row.classList.remove('busy')); }
      /* Not a .mode .btn: .mode .btn:disabled+.cap recolours the caption beside
         it, which would put a second element into a state the app never shows. */
      for(const id of ['btnExport','btnImport']){
        const b=document.getElementById(id);
        if(b&&!b.disabled){ b.disabled=true; undo.push(()=>{b.disabled=false;}); }
      }
      for(const d of document.querySelectorAll('details'))
        if(!d.open){ d.open=true; undo.push(()=>{d.open=false;}); }
      // the drill's own text, without playing a card: both panes are display
      // toggles on separate elements, so the stage can be shown under the board
      const stage=document.getElementById('stage');
      if(stage&&!stage.classList.contains('live')){
        stage.classList.add('live'); undo.push(()=>stage.classList.remove('live'));
      }
      /* Read every colour before the ink goes, not after: the rule below is
         what the element is wearing while the screenshot is taken, so a
         getComputedStyle() from inside __measure reads transparent and every
         ratio comes back 1.00 — which fails loudly, but only by luck.
         Descendants are included in it because .mast-right b, .first-run b and
         .tap-due small set colours of their own: unsilenced, their glyphs land
         inside the parent's line boxes and get sampled as backdrop. */
      window.__meta={};
      for(const s of sels){
        const el=document.querySelector(s); if(!el) continue;
        const cs=getComputedStyle(el);
        const isSvg=!!(el.namespaceURI&&el.namespaceURI.includes('svg'));
        const ink=px(isSvg?cs.fill:cs.color);
        ink[3]*=opacityOf(el);
        __meta[s]={ink, size:parseFloat(cs.fontSize), weight:cs.fontWeight, own:hex(px(cs.backgroundColor))};
        el.setAttribute('data-ink-off','');
      }
      document.head.insertAdjacentHTML('beforeend','<style id="inkOff">[data-ink-off],[data-ink-off] *{'+
        'color:transparent!important;fill:transparent!important;text-shadow:none!important}</style>');
      undo.push(()=>{ document.getElementById('inkOff').remove();
        document.querySelectorAll('[data-ink-off]').forEach(e=>e.removeAttribute('data-ink-off')); });
    };
    window.__unstage=()=>{ undo.reverse().forEach(f=>f()); undo=[]; };
    window.__place=async sel=>{
      const el=document.querySelector(sel);
      if(!el) return false;
      const box=el.getBoundingClientRect();
      if(!box.width||!box.height) return false;
      el.scrollIntoView({block:"center"});
      // a capture fired straight after a scroll or a setLook catches the paint before it
      await new Promise(go=>requestAnimationFrame(()=>requestAnimationFrame(go)));
      return true;
    };
    window.__measure=async(sel,shot)=>{
      await load(shot);
      const el=document.querySelector(sel), m=__meta[sel], ink=m.ink;
      const rg=document.createRange(); rg.selectNodeContents(el);
      const lines=[...rg.getClientRects()].filter(r=>r.width>2&&r.height>2);
      const boxes=(lines.length?lines:[el.getBoundingClientRect()]).slice(0,3);
      let worst=null;
      for(const r of boxes)
        for(const bx of [r.left+1, r.left+r.width/2-4, r.right-9])
          for(let dx=0;dx<8;dx++)
            for(const f of [.3,.5,.7]){
              const bg=at(bx+dx, r.top+r.height*f);
              if(!bg) continue;
              const v=ratio(over(ink,bg),bg);
              if(!worst||v<worst.v) worst={v,bg};
            }
      if(!worst) return {sel,missing:true};
      /* Pinned at the element's own top edge, not its middle: a scale that is
         two per cent out still lands in the middle of a big flat button and
         says yes, while every sample further down the page is off-target. */
      const box=el.getBoundingClientRect(), cx=box.left+box.width/2;
      const mid=at(cx, box.top+2), out=at(cx, box.top-4);
      return {sel, ratio:+worst.v.toFixed(2), bg:hex(worst.bg),
              size:m.size, weight:m.weight, mid:mid&&hex(mid), out:out&&hex(out), own:m.own};
    };
  })()`);
  const shot = async () => (await send('Page.captureScreenshot', { format: 'png' })).result.data;
  for (const preset of presets) {
  await ev(`setLook({theme:${JSON.stringify(preset)}, font:'lastcall', size:'m'})`);
  await ev(`__stage(${JSON.stringify(SELS)})`);
  const contrast = [];
  for (const sel of SELS) {
    if (!await ev(`__place(${JSON.stringify(sel)})`)) { contrast.push({ sel, missing: true }); continue; }
    contrast.push(await ev(`__measure(${JSON.stringify(sel)}, ${JSON.stringify(await shot())})`));
  }
  await ev(`__unstage()`);
  for (const c of contrast) {
    if (c.missing) { console.log(`SKIP  a11y: [${preset}] ${c.sel} is not on screen here — not measured`); continue; }
    if (c.sel === '.btn-go') ok(`a11y: [${preset}] the sweep is aimed at the pixels the element occupies `
                                + `(${c.mid} inside its top edge, ${c.out} just above it, fill is ${c.own})`,
                                c.mid === c.own && c.out !== c.own);
    const large = c.size >= 24 || (c.size >= 18.66 && +c.weight >= 700);
    const need = large ? 3 : 4.5;
    ok(`a11y: [${preset}] ${c.sel} contrast ${c.ratio}:1 on painted ${c.bg} clears ${need}:1`, c.ratio >= need);
  }
  }
  // or every section below here is measured in whichever preset the loop stopped on
  await ev(`setLook({theme:'lastcall', font:'lastcall', size:'m'})`);

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

  /* --- the phone. This is played standing up, one-handed, so the checks that
     matter are measured at a phone's width, not asserted from the CSS. */
  const PHONE_W = 390;
  const phone = on => on
    ? send('Emulation.setDeviceMetricsOverride', { width: PHONE_W, height: 844, deviceScaleFactor: 3, mobile: true })
    : send('Emulation.clearDeviceMetricsOverride');
  await reset(); await phone(true); await nav();

  /* Measured against the width being emulated, and off the same constant, not
     against window.innerWidth. With width=device-width and no maximum-scale the
     emulator widens the layout viewport to whatever the content turns out to
     need, so innerWidth grows to meet scrollWidth and the two stay equal however
     far the board spills — the old form was a check that could not fail.
     Demonstrated with the large text step wound up to 3: the board really is
     888px across and the comparison still said yes. */
  const fitsPhone = () => ev(`document.documentElement.scrollWidth <= ${PHONE_W + 1}`);

  ok('phone: the board does not scroll sideways', await fitsPhone());
  ok('phone: the due count survives — it is the reason to read the row', await ev(`(()=>{
    const d=document.querySelector('.tap-due');
    return !!d && d.offsetWidth+d.offsetHeight>0;})()`));
  /* The mastery bar was an inline span, so its height was ignored and it drew
     nothing at any width. A bar that is not a box is not a bar. */
  ok('phone: the mastery bar is actually a box', await ev(`(()=>{
    const r=document.querySelector('.tap-bar').getBoundingClientRect();
    return r.width>20 && r.height>=4;})()`));

  /* Every visible control has to be thumb-sized. Named by nothing, so it covers
     controls that do not exist yet. */
  const tiny = async where => ev(`(()=>{
    return [...document.querySelectorAll('button, a[href], input, select, summary, [tabindex]')]
      .filter(el=>el.offsetWidth+el.offsetHeight>0 && !el.disabled)
      .filter(el=>{const r=el.getBoundingClientRect(); return Math.min(r.width,r.height) < 44;})
      .map(el=>el.id||el.className||el.tagName).slice(0,8);
  })()`).then(list => { ok(`phone: every control on the ${where} is thumb-sized`, list.length === 0);
    if (list.length) console.log('        under 44px: ' + list.join(', ')); });
  await tiny('board');

  /* The settings panel is a <details>, and a closed one measures nothing, so
     none of it is covered until it is opened. The smallest text step is where
     to look: nothing in this sheet scales padding, so a control sized by its
     own type is the one that falls under the thumb first. Demonstrated by
     taking .drawer select back out of the min-height:44px list — all four
     dropdowns print at about 41px. */
  await ev(`document.getElementById('setDrawer').open=true; setLook({size:'s'})`);
  await tiny('settings panel at the smallest text');
  // demonstrated by widening the settings grid's minmax to 420px: the panel
  // alone is then wider than the phone, at every text step
  ok('phone: nor does it scroll sideways with the settings panel open', await fitsPhone());
  /* Under 16px iOS zooms into a field on focus and never zooms back out. The
     sheet has said so since the search row was added and nothing ever measured
     it — and the text step is precisely what can drag it back under.
     Demonstrated by replacing the max(16px, …) with a bare calc: 14.7px. */
  ok('phone: the fields iOS zooms into never drop under 16px', await ev(`
    ['deckSearch','setTheme','setSitting','tsv'].every(id=>
      parseFloat(getComputedStyle(document.getElementById(id)).fontSize)>=16)`));
  /* Every combination, because picking the one that looked worst picked wrong.
     This was a single assertion on system-ui at the large step, reasoning that
     system-ui is wider than Antonio — but the row that spills is the search
     row, whose count is mono, and ui-monospace resolves to Consolas, which is
     narrower than JetBrains Mono. system+l was the only one of the nine that
     fitted, so the check passed while lastcall+l and serif+l were 436px across.
     Demonstrated by taking min-width:0 back off .search-row input. */
  for (const font of ['lastcall', 'system', 'serif'])
    for (const size of ['s', 'm', 'l']) {
      await ev(`setLook({font:'${font}', size:'${size}'})`);
      const w = await ev('document.documentElement.scrollWidth');
      ok(`phone: nor at ${size} text in ${font}`, w <= PHONE_W + 1);
      if (w > PHONE_W + 1) console.log(`        ${w}px across a ${PHONE_W}px phone`);
    }
  await ev(`setLook({theme:'lastcall', font:'lastcall', size:'m'})`);

  await ev(`document.getElementById('btnDrill').click();
            (()=>{ for(let i=0;i<12;i++){ if(!flipped) flip(); answer(i%3?2:1); } })();
            document.getElementById('btnQuit').click();
            document.getElementById('btnRound').click();
            (()=>{ for(let i=0;i<10;i++){ if(!flipped) flip(); answer(1); } })();
            document.getElementById('btnBack').click();
            document.getElementById('btnStats').click()`);
  await tiny('form guide');
  /* A drawing that contains text must never be scaled down: at 100% of a phone
     from a 640-unit box, 9.5px labels were landing at about 5px. */
  const scaled = await ev(`[...document.querySelectorAll('#statsBody svg')].map(s=>{
    const vb=(s.getAttribute('viewBox')||'0 0 1 1').split(/\\s+/).map(Number);
    return +(s.getBoundingClientRect().width / vb[2]).toFixed(3);
  })`);
  ok(`phone: no chart is scaled below its own type size (${scaled.join(', ')})`,
     scaled.length > 0 && scaled.every(s => s >= 0.95));
  ok('phone: the category bars are text, so they wrap instead of shrinking', await ev(`
    document.querySelectorAll('#statsBody .bar-row').length>=1
    && document.querySelectorAll('#statsBody .bar-row svg').length===0`));
  await ev(`document.getElementById('btnStatsBack').click()`);
  await tiny('board after a session');

  await ev(`document.getElementById('btnBoardGame').click()`);
  ok('phone: the game grid keeps its swipe to itself', await ev(`
    getComputedStyle(document.querySelector('.grid-wrap')).overscrollBehaviorX==='contain'`));
  await ev(`document.getElementById('btnQuizDone').click(); document.getElementById('btnBack').click()`);

  await phone(false); await reset(); await nav();

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

  /* --- several people, one phone. Not an account: nothing is sent anywhere,
     and a solo user must not pay a pixel for it. */
  await reset(); await nav();
  ok('who: one person alone sees no chips at all', await ev(`
    S.roster.length===1 && document.getElementById('whoRow').offsetHeight===0`));

  await ev(`document.getElementById('btnDrill').click();
            (()=>{ if(!flipped) flip(); answer(3); })();
            document.getElementById('btnQuit').click()`);
  const mineId = await ev('Object.keys(S.sched)[0]');
  const mineCount = await ev('Object.keys(S.sched).length');

  await ev(`document.getElementById('btnWhoAdd').click();
            document.getElementById('whoName').value='Marta';
            document.getElementById('btnWhoSave').click()`);
  await sleep(200);
  ok('who: adding somebody deals them in and names the first person', await ev(`
    S.roster.length===2 && S.roster[0].name==='You' && S.roster[1].name==='Marta'`));
  ok('who: and the phone is now theirs', await ev(`S.cur===S.roster[1].id`));
  ok('who: they start with nothing scheduled', await ev(`Object.keys(S.sched).length===0`));
  ok('who: your streak is not theirs', await ev(`!S.streak && !S.answered`));
  ok('who: two chips, one of them pressed', await ev(`
    document.querySelectorAll('#whoRow .who-chip').length===2
    && document.querySelectorAll('#whoRow .who-chip[aria-pressed="true"]').length===1`));

  await ev(`document.getElementById('btnDrill').click();
            (()=>{ for(let i=0;i<3;i++){ if(!flipped) flip(); answer(2); } })();
            document.getElementById('btnQuit').click()`);
  const martaCount = await ev('Object.keys(S.sched).length');
  ok('who: their drilling does not touch yours', martaCount > 0);

  await ev(`document.querySelector('#whoRow .who-chip').click()`);
  await sleep(200);
  ok('who: switching back brings your schedule with it',
     await ev('Object.keys(S.sched).length') === mineCount
     && await ev(`!!S.sched[${JSON.stringify(mineId)}]`));
  ok('who: and not a card of theirs', await ev('Object.keys(S.sched).length') === mineCount);

  /* Typing is a personal preference, and its pressed state was only ever set at
     boot — so it used to survive a switch and lie about whose setting it was. */
  // whoever is holding it right now turns typing on
  await ev(`document.getElementById('btnTyped').click()`);
  const typist = await ev('S.cur');
  ok('who: one of you types the answers', await ev(`
    S.typed===true && document.getElementById('btnTyped').getAttribute('aria-pressed')==='true'`));
  await ev(`[...document.querySelectorAll('#whoRow .who-chip')].find(c=>c.dataset.who!==S.cur).click()`);
  await sleep(200);
  ok('who: and the other one flips the card', await ev(`
    S.cur!==${JSON.stringify(typist)} && !S.typed
    && document.getElementById('btnTyped').getAttribute('aria-pressed')==='false'`));
  await ev(`document.querySelector('#whoRow .who-chip[data-who="'+${JSON.stringify(typist)}+'"]').click()`);
  await sleep(200);
  ok('who: switching back remembers they were typing', await ev(`
    S.typed===true && document.getElementById('btnTyped').getAttribute('aria-pressed')==='true'`));
  await ev(`document.getElementById('btnTyped').click()`);

  // the shared half stays shared, for the reasons stated in the code
  await ev(`S.games=[[today(),['Marta','Sam'],[600,-200]]]; S.user=[{c:'u:x',cn:'X',q:'Shared q',a:'A'}]; save();
            document.querySelectorAll('#whoRow .who-chip')[1].click()`);
  await sleep(200);
  ok('who: the table’s record is the room’s, not one person’s', await ev(`(S.games||[]).length===1`));
  ok('who: and so are the cards you add', await ev(`(S.user||[]).length===1`));

  await ev('flush()'); await nav();
  ok('who: everybody survives a reload', await ev(`
    S.roster.length===2 && S.roster.map(p=>p.name).join()==='You,Marta'`));
  ok('who: on whichever person was holding it', await ev(`S.roster[1].id===S.cur`));
  ok('who: with their own schedule, not the other one', await ev('Object.keys(S.sched).length') === martaCount);
  ok('who: and it is all one key, so a full quota cannot tear it', await ev(`
    Object.keys(localStorage).filter(k=>k.startsWith('lastcall:v')).length===1`));

  // a reset is for whoever is holding the phone
  await ev(`window.confirm=()=>true; document.getElementById('btnReset').click()`);
  await sleep(200);
  ok('reset: it clears the person holding it', await ev(`Object.keys(S.sched).length===0`));
  // defensive: a wiped roster must report, not throw the harness off the rails
  ok('reset: it leaves everybody else alone', await ev(`
    S.roster.length===2 && Object.keys(people[S.roster[0].id]?.sched||{}).length===${mineCount}`));
  ok('reset: and still spares the cards and the table', await ev(`
    (S.user||[]).length===1 && (S.games||[]).length===1`));

  // a backup is the whole phone
  await ev(`document.getElementById('btnExport').click()`);
  ok('backup: it says how many of you it took', await ev(`
    /all 2 of you/.test(document.getElementById('ioMsg').textContent)`));
  await reset(); await nav();
  await ev(`(async()=>{
    const f=new File([JSON.stringify({v:4,cur:'b',roster:[{id:'a',name:'Ann'},{id:'b',name:'Ben'}],
      me:{a:{sched:{zz:[1,2.5,0,1,0]},streak:4},b:{sched:{},streak:9}},
      on:[],off:[],user:[],games:[],names:''})],'b.json',{type:'application/json'});
    const dt=new DataTransfer(); dt.items.add(f);
    const inp=document.getElementById('fileImport');
    Object.defineProperty(inp,'files',{value:dt.files,configurable:true});
    inp.dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,150));
  })()`);
  ok('backup: restoring brings everybody back', await ev(`
    S.roster.map(p=>p.name).join()==='Ann,Ben' && S.cur==='b' && S.streak===9`));
  ok('backup: including the one who was parked', await ev(`
    people.a && people.a.streak===4 && !!people.a.sched.zz`));

  // an old single-person backup still restores, as one person
  await ev(`(async()=>{
    const f=new File([JSON.stringify({sched:{yy:[1,2.5,0,1,0]},streak:2,answered:7})],'old.json',{type:'application/json'});
    const dt=new DataTransfer(); dt.items.add(f);
    const inp=document.getElementById('fileImport');
    Object.defineProperty(inp,'files',{value:dt.files,configurable:true});
    inp.dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,150));
  })()`);
  ok('backup: a backup from before any of this restores as one person', await ev(`
    S.roster.length===1 && S.streak===2 && S.answered===7 && !!S.sched.yy`));

  // --- the board says what each mode does, and introduces itself once
  await reset(); await nav();
  ok('board: every mode carries a caption saying what it does', await ev(`
    [...document.querySelectorAll('.mode')].filter(m=>m.offsetHeight>0)
      .every(m=>(m.querySelector('.cap')?.textContent||'').trim().length>15)`));
  ok('board: the games are grouped and say they leave your schedule alone', await ev(`
    /leave your schedule alone/.test(document.querySelector('.games-head').textContent)`));
  ok('board: the tagline survives the shelf count landing', await ev(`
    /categories your table keeps punting on/.test(document.getElementById('subline').textContent)`));
  ok('board: and the shelf count is still on screen somewhere', await ev(`(()=>{
    const el=document.getElementById('shelfNote');
    return el.offsetHeight===0 || /on the shelf/.test(el.textContent);})()`));
  ok('board: a first-timer gets told what this is', await ev(`
    document.getElementById('firstRun').offsetHeight>0`));
  // it belongs to the board, not to every view the board happens to be behind
  ok('board: and it is not still there mid-card', await ev(`
    document.getElementById('btnDrill').click();
    const gone=document.getElementById('firstRun').offsetHeight===0;
    document.getElementById('btnQuit').click(); gone`));
  ok('board: the sticking-points count does not eat its own caption', await ev(`(()=>{
    S.sched={}; DECK.slice(0,3).forEach(c=>S.sched[c.id]=[1,2.5,today(),3,5]);
    renderBoard();
    const m=document.getElementById('modeLeech');
    return m.offsetHeight>0 && /beaten you five times/.test(m.querySelector('.cap').textContent)
           && /\\(3\\)/.test(document.getElementById('leechN').textContent);})()`));

  // a disabled control states its reason where the control is
  await ev(`S=DEFAULT(); CATS.forEach(c=>{ if(isHouseCat(c.id)) S.off.push(c.id); }); renderBoard()`);
  ok('board: a disabled drill says why in its own caption', await ev(`
    document.getElementById('btnDrill').disabled
    && /nothing is due/.test(document.getElementById('capDrill').textContent)`));
  ok('board: and so does a board with too few categories', await ev(`
    document.getElementById('btnBoardGame').disabled
    && /needs two categories/.test(document.getElementById('capBoard').textContent)`));

  await reset(); await nav();
  await ev(`document.getElementById('btnDrill').click();
            (()=>{ if(!flipped) flip(); answer(2); })();
            document.getElementById('btnQuit').click()`);
  ok('board: and never introduces itself again once you have drilled', await ev(`
    document.getElementById('firstRun').offsetHeight===0`));
  await ev('flush()'); await nav();
  ok('board: not after a reload either', await ev(`
    document.getElementById('firstRun').offsetHeight===0`));

  /* --- the drill has an ending. It is the primary action and the only mode
     that used to finish by silently dropping you back on the board. */
  await reset(); await nav();
  await ev(`document.getElementById('btnDrill').click();
            (()=>{ let n=0; while(document.getElementById('stage').classList.contains('live') && n++<400){
              if(!flipped) flip(); answer(n%4===0?1:2); } })()`);
  ok('drill: it ends on a scorecard instead of dropping you on the board', await visible('resultView'));
  ok('drill: the number is cards, not a score out of anything', await ev(`
    /^\\d+cards?$/.test(document.getElementById('scoreNum').textContent.replace(/\\s/g,''))`));
  ok('drill: it says what it did to the schedule', await ev(`
    /put to bed/.test(document.getElementById('scoreLine').textContent)`));
  ok('drill: everything it says is coming back today really is due today', await ev(`
    [...drillGrades].filter(([,g])=>g===1).every(([id])=>S.sched[id][2]<=today())`));
  ok('drill: and the ones put to bed are not', await ev(`
    [...drillGrades].filter(([,g])=>g>1).every(([id])=>S.sched[id][2]>today())`));
  ok('drill: the button offers what is actually left, not a round twenty', await ev(`(()=>{
    const act=activeCats();
    const left=Math.min(20, dueCards().filter(c=>act.includes(c.c)).length
                          + newCards().filter(c=>act.includes(c.c)).length);
    const b=document.getElementById('btnAgain');
    return left ? b.textContent==='Another '+left : b.disabled;})()`));
  ok('drill: the sitting is not kept in your saved progress', await ev(`
    !JSON.stringify(S).includes('drillGrades') && typeof S.drillGrades==='undefined'`));
  await ev(`document.getElementById('btnBack').click()`);

  // --- the form guide can be acted on
  await ev(`document.getElementById('btnStats').click()`);
  ok('stats: a category bar is a button that drills it', await ev(`
    !!document.querySelector('#statsBody .bar-row[data-dive]')`));
  const barCat = await ev(`document.querySelector('#statsBody .bar-row[data-dive]').dataset.dive`);
  await ev(`document.querySelector('#statsBody .bar-row[data-dive]').click()`);
  await sleep(900);
  ok('stats: pressing it starts a dive in that category', await ev(
    `diveCat===${JSON.stringify(barCat)} && Q.every(id=>BY_ID[id].c===${JSON.stringify(barCat)})`));
  await ev(`document.getElementById('btnQuit').click()`);

  /* --- an empty pool must not be reported as a clean sheet */
  await reset(); await nav();
  await ev(`CATS.forEach(c=>{ if(isHouseCat(c.id)&&!S.off.includes(c.id)) S.off.push(c.id); });
            S.on=[]; save(); renderBoard();
            document.getElementById('btnRound').click()`);
  ok('empty: a round with nothing switched on does not deal', await ev(
    `document.getElementById('board').classList.contains('live') && Q.length===0`));
  ok('empty: and it says why, where the next repaint cannot wipe it', await ev(`
    /Nothing is switched on/.test(document.getElementById('notice').textContent)
    && document.getElementById('notice').offsetHeight>0`));
  ok('empty: it never claims a clean sheet over nought out of nought', await ev(`
    !/Clean sheet/.test(document.getElementById('scoreLine').textContent)`));
  await ev(`document.getElementById('btnNight').click()`);
  ok('empty: neither does the whole night', await ev(
    `document.getElementById('board').classList.contains('live') && night===null`));

  // the storage warning has to outlive the repaint that used to eat it
  await reset(); await nav();
  await ev(`notice('Storage is full — progress is not being saved. Export a backup.',true); renderBoard()`);
  ok('notice: the storage warning survives a repaint', await ev(`
    /Storage is full/.test(document.getElementById('notice').textContent)
    && document.getElementById('notice').offsetHeight>0`));

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

  /* Typing must never move another person's money on its own. Enter on an empty
     box judges "wrong", and with the flip button hidden there was no way out —
     one typo cost a named human the tile with no appeal. */
  await ev(`S.typed=true; document.querySelector('.tile[data-cell="2:3"]').click()`);
  const purseBefore = await ev('quiz.players.map(p=>p.score).join()');
  await ev(`(()=>{const t=document.getElementById('typed');
    t.value=''; t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  ok('table: an empty answer does not take the tile off anybody',
     await ev('quiz.players.map(p=>p.score).join()') === purseBefore);
  ok('table: it reveals the card and hands the grade to a human', await visible('roundRow'));
  ok('table: and the grade row says what the tile is worth', await ev(`
    document.getElementById('rMiss').textContent==='-$800'
    && document.getElementById('rGot').textContent==='$800'`));
  await ev(`answer(0); S.typed=false`);

  await ev(`document.getElementById('btnQuizDone').click()`);
  ok('table: the standings name the winner', await ev(`/Alice takes the night/.test(document.getElementById('scoreLine').textContent)`));
  ok('table: every seat is on the scorecard', await ev(`document.querySelectorAll('#missedList li').length===2`));
  ok('table: red money is legible, not amber', await ev(`!!document.querySelector('#missedList b.neg')`));
  ok('table: the game lands on the record, scores and all',
     await ev(`(S.games||[]).length===1 && S.games[0][1].join()==='Alice,Bob' && S.games[0][2].join()==='-600,-1000'`));
  ok('table: and your personal history never noticed', await ev('JSON.stringify(S.hist)') === histBefore);

  // the record has to survive a reload, or it is not a record
  await ev('flush()'); await nav();
  ok('table: the record survives a reload', await ev(`(S.games||[]).length===1 && S.games[0][2].join()==='-600,-1000'`));
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
  /* One node for one flag. Demonstrated by leaving a second #btnTyped in the
     panel foot when it moved into the settings panel: two switches for one
     boolean is how the two of them come apart later. */
  ok('typed: one switch for it, not two kept in step', await ev(`
    document.querySelectorAll('#btnTyped').length===1`));
  /* The pressed state used to be set at boot and never again, so handing the
     phone to somebody who types showed a switch reading off while the drill
     asked them to type. Demonstrated by dropping the btnTyped line out of
     renderBoard()'s sync block — the click path still works and only this
     fails. */
  await ev(`S.typed=true; renderBoard()`);
  ok('typed: the switch follows the state, not only the other way round', await ev(`
    document.getElementById('btnTyped').getAttribute('aria-pressed')==='true'`));
  await ev(`S.typed=false; renderBoard()`);
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

  // --- how it looks, and how it drills
  await reset(); await nav();
  /* Demonstrated by moving the applier <script> out of <head> and down to just
     inside <body>. Everything still works and every colour assertion still passes —
     this is the only one that catches the flash of walnut before a light preset
     paints. */
  ok('look: it is on the page before the body is, so a light preset never flashes walnut', await ev(`
    [...document.head.querySelectorAll('script')].some(s=>/applyLook/.test(s.textContent))`));

  await ev(`setLook({theme:'paper'})`);
  await nav();
  /* Demonstrated by taking the setItem out of setLook(): the preset paints, and
     is gone after the reload because nothing wrote it down. */
  ok('look: a preset survives a reload', await ev(`document.documentElement.dataset.theme==='paper'`));
  /* Demonstrated by deleting the meta line from applyLook(). Nothing else
     notices, and the phone's own status bar stays walnut over a white page. */
  ok('look: the browser bar is painted to match', await ev(`
    document.querySelector('meta[name=theme-color]').content===THEMES.paper`));
  /* A literal map rather than anything read off the page — color-scheme is what
     draws the scrollbar, the search field's clear button and the dropdown's own
     chrome, and a light preset that forgets it gets dark platform furniture on
     white. Demonstrated by deleting the line from the paper block. */
  ok('look: every preset tells the platform which way up it is', await ev(`
    Object.entries({lastcall:'dark',slate:'dark',paper:'light',contrast:'light'}).every(([t,want])=>{
      setLook({theme:t});
      return getComputedStyle(document.documentElement).colorScheme===want;})`));

  await ev(`localStorage.setItem(LOOK_KEY,'{"theme":"</style>","font":42,"size":["l"]}')`);
  await nav();
  /* Demonstrated by weakening resolveLook to a truthiness test, o.theme?o.theme,
     instead of the own-property test: the attribute takes the junk value, no preset
     block matches it, and the app paints the bare :root — so it is the dataset
     half that goes red, not the colour. */
  ok('look: a hostile stored value paints a shipped preset, not nothing', await ev(`
    document.documentElement.dataset.theme==='lastcall'
    && document.documentElement.dataset.font==='lastcall'
    && document.documentElement.dataset.size==='m'
    && getComputedStyle(document.body).backgroundColor==='rgb(36, 26, 20)'`));
  await ev(`localStorage.setItem(LOOK_KEY,'{"theme":')`);
  await nav();
  /* Guarded twice — resolveLook wraps the parse, and the boot call falls back
     again — so both have to go before this can fail. With neither, the head
     script throws, the dataset is never stamped and nothing below it is wired. */
  ok('look: torn json is a shipped preset, not a page that will not start', await ev(`
    document.documentElement.dataset.theme==='lastcall' && !!document.getElementById('btnDrill')`));

  /* sw.js hands cross-origin requests straight to the network and never caches
     them, so a family outside the one <link> in the head is a family that is
     not there in a basement.

     Measured first, before anything has touched the font, and that ordering is
     the whole assertion: the structural check below walks all three settings
     itself, so a baseline taken after it already contains whatever a bad
     setting fetched, and the comparison passes while reporting the offending
     host in its own name. Demonstrated by injecting a second stylesheet <link>
     when 'system' is picked — this way round it goes red, the other way round
     it printed the intruder and passed. */
  const originsOf = `[...new Set(performance.getEntriesByType('resource')
    .map(e=>new URL(e.name).origin))].filter(o=>o!==location.origin).sort()`;
  const hostsBefore = await ev(originsOf);
  await ev(`FONTS.forEach(f=>setLook({font:f})); setLook({font:'lastcall'});
            document.fonts.ready.then(()=>true)`);
  await sleep(900);
  const hostsAfter = await ev(originsOf);
  ok(`offline: asking for each font in turn fetched nothing new (${hostsAfter.join(' ') || 'nothing off-site'})`,
     hostsAfter.join() === hostsBefore.join());
  // and the same fence stated as markup, which catches a host that never
  // resolves and so never records a resource entry at all
  ok('offline: no font choice reaches for a host the basement cannot serve', await ev(`
    FONTS.every(f=>{ setLook({font:f});
      const off=[...document.querySelectorAll('link[href]')]
        .filter(l=>new URL(l.href,location.href).origin!==location.origin);
      return off.filter(l=>l.rel==='stylesheet').length===1
        && [...new Set(off.map(l=>new URL(l.href).host))].sort().join()
           ==='fonts.googleapis.com,fonts.gstatic.com';})`));
  await ev(`setLook({font:'lastcall'})`);

  await reset(); await nav();
  await ev(`(()=>{const s=document.getElementById('setSitting');
            s.value='10'; s.dispatchEvent(new Event('change'));})()`);
  ok('sitting: the number you chose is the one that is kept', await ev(`S.sitting===10`));
  /* The slice and the sentence are written in two different places, which is
     what makes this the pair that gets half-done. Demonstrated by leaving the
     sentence on its old hardcoded twenty while the slice moves. */
  ok('sitting: and the sentence on the board says the same number', await ev(`
    /10 per sitting/.test(document.getElementById('sessionNote').textContent)`));
  await ev(`document.getElementById('btnDrill').click()`);
  /* Demonstrated by putting the round twenty back into startDrill — both the
     new-card budget and the slice. The slice on its own is not enough: with
     nothing due yet it is the budget that decides the deal, and the check still
     passed with a hardcoded twenty sitting right there. */
  ok('sitting: the drill deals the size you chose, not a round twenty', await ev(`Q.length===10`));
  await ev(`document.getElementById('btnQuit').click()`);

  // --- hand-added cards
  await reset(); await nav();
  await ev(`document.getElementById('tsv').value="Local\\tWhich street the town hall is on\\tMill Street\\tcomes up every third round\\r\\nMusic Before 1980\\tWho played bass for the Jam\\tBruce Foxton\\r\\njunk\\r\\n";
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
