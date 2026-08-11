/* Harvests the Open Trivia Database into .cache/opentdb/.
   CC BY-SA 4.0 — https://opentdb.com/

   One request per IP per 5 seconds, 50 questions per call, so a full sweep is
   roughly ten minutes. Every page is cached, so a re-run costs nothing and an
   interrupted run picks up where it stopped.

   node scripts/fetch-opentdb.mjs
*/
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const CACHE = '.cache/opentdb';
const GAP = 5500;                       // their limit is 5s; leave a margin
const sleep = ms => new Promise(r => setTimeout(r, ms));

mkdirSync(CACHE, { recursive: true });

let lastCall = 0;
async function api(url) {
  const wait = GAP - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r.json();
}

const cats = (await api('https://opentdb.com/api_category.php')).trivia_categories;
const counts = {};
for (const c of cats) {
  const f = `${CACHE}/count-${c.id}.json`;
  if (existsSync(f)) { counts[c.id] = JSON.parse(readFileSync(f, 'utf8')); continue; }
  const r = await api(`https://opentdb.com/api_count.php?category=${c.id}`);
  counts[c.id] = r.category_question_count;
  writeFileSync(f, JSON.stringify(counts[c.id]));
  console.log(`counted ${c.name}: ${counts[c.id].total_question_count} total`);
}

// A session token stops the API repeating questions until the pool is exhausted.
const token = (await api('https://opentdb.com/api_token.php?command=request')).token;

let grabbed = 0;
for (const c of cats) {
  const total = counts[c.id].total_question_count;
  const pages = Math.ceil(total / 50);
  for (let page = 0; page < pages; page++) {
    const f = `${CACHE}/cat-${c.id}-p${page}.json`;
    if (existsSync(f)) { grabbed += JSON.parse(readFileSync(f, 'utf8')).length; continue; }
    // base64 avoids the HTML-entity soup the default encoding returns
    const r = await api(`https://opentdb.com/api.php?amount=50&category=${c.id}&encode=base64&token=${token}`);
    if (r.response_code === 4) break;            // category exhausted for this token
    if (r.response_code === 5) { page--; await sleep(GAP); continue; }   // rate limited, retry
    if (r.response_code !== 0) { console.log(`  ${c.name} p${page}: response_code ${r.response_code}, stopping`); break; }
    writeFileSync(f, JSON.stringify(r.results));
    grabbed += r.results.length;
    console.log(`${c.name} p${page}: +${r.results.length} (${grabbed} so far)`);
  }
}

console.log(`\ncached ${grabbed} questions in ${CACHE}`);
