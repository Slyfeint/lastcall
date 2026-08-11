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
  ok('shelf: an area never renders more than a dozen rows unasked',
     await ev(`[...document.querySelectorAll('.area')].every(h=>{
       let n=0,el=h.nextElementSibling;
       while(el&&el.classList.contains('tap')){n++;el=el.nextElementSibling;}
       return n<=12;          // a literal, not PER_AREA — a check must not read its own answer
     })`));

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
