/* Builds Jeopardy! decks ON YOUR OWN MACHINE. They are gitignored and they are
   not deployed, and you should not publish them.

   The corpus is jwolle1/jeopardy_clue_dataset. Its author asks that it not be
   used in public-facing sites or apps, and the clues are the property of
   Jeopardy Productions, Inc. Personal study is what this is for.

   node scripts/build-jeopardy.mjs
*/
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { check } from './lint-decks.mjs';

const SRC = 'https://raw.githubusercontent.com/jwolle1/jeopardy_clue_dataset/main/combined_season1-42.tsv';
const TSV = '.cache/jeopardy.tsv';
const OUT = 'public/decks/jeopardy';
const MIN_PER_DECK = 60;        // a category worth drilling has to recur

mkdirSync('.cache', { recursive: true });
if (!existsSync(TSV)) {
  console.log('downloading 76 MB of clues (once) …');
  const r = await fetch(SRC);
  if (!r.ok) { console.error(`${r.status} fetching the corpus`); process.exit(2); }
  await pipeline(Readable.fromWeb(r.body), createWriteStream(TSV + '.part'));
  const { size } = statSync(TSV + '.part');
  if (size < 50e6) { rmSync(TSV + '.part'); console.error(`only got ${size} bytes, refusing a truncated corpus`); process.exit(2); }
  writeFileSync(TSV, readFileSync(TSV + '.part')); rmSync(TSV + '.part');
}

const rows = readFileSync(TSV, 'utf8').split(/\r?\n/);
const head = rows[0].split('\t');
const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
for (const need of ['category', 'answer', 'question', 'air_date']) {
  if (col[need] === undefined) { console.error(`corpus is missing the ${need} column; got ${head}`); process.exit(2); }
}

/* On the show the host reads the "answer" and the contestant gives the
   "question". As a flashcard that is the clue on the front and the response on
   the back — so they swap here. Getting this backwards makes every card
   nonsense, which is why it is the first thing the tally would show. */
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const clean = s => s.replace(/<[^>]+>/g, '').replace(/\\(['"])/g, '$1').replace(/\s+/g, ' ').trim();
const MEDIA = /\b(seen here|heard here|shown here|this (video|audio|picture|photo|image)|\[.*(video|audio|image).*\])\b/i;

const byCat = new Map();
const seen = new Set();
let read = 0, kept = 0;
const dropped = { media: 0, dupe: 0, short: 0, lint: 0 };

for (let i = 1; i < rows.length; i++) {
  const f = rows[i].split('\t');
  if (f.length < head.length) continue;
  read++;
  const q = clean(f[col.answer]);          // the clue
  const a = clean(f[col.question]);        // the response
  const cat = clean(f[col.category]);
  if (!q || !a || q.length < 15) { dropped.short++; continue; }
  if (MEDIA.test(q)) { dropped.media++; continue; }
  if (check({ q, a })) { dropped.lint++; continue; }
  const k = norm(q);
  if (seen.has(k)) { dropped.dupe++; continue; }
  seen.add(k);
  if (!byCat.has(cat)) byCat.set(cat, []);
  byCat.get(cat).push({ q, a, y: (f[col.air_date] || '').slice(0, 4), s: 'jarchive' });
  kept++;
}

mkdirSync(OUT, { recursive: true });
const decks = [];
const overflow = [];
let inDecks = 0, rareCats = 0;
for (const [cat, cards] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
  // a one-off category is no use as a rabbit hole, but the clues are still good
  // drilling, so they go in the mixed decks rather than on the floor
  if (cards.length < MIN_PER_DECK) { overflow.push(...cards); rareCats++; continue; }
  const id = 'j-' + norm(cat).slice(0, 40);
  writeFileSync(`${OUT}/${id}.json`, JSON.stringify({ id, name: cat, style: `${cards.length} clues from the show`, area: 'Jeopardy!', source: 'jarchive', cards }));
  decks.push({ id, name: cat, style: `${cards.length} clues from the show`, area: 'Jeopardy!', count: cards.length, file: `decks/jeopardy/${id}.json` });
  inDecks += cards.length;
}
const CHUNK = 8000;
for (let i = 0; i * CHUNK < overflow.length; i++) {
  const cards = overflow.slice(i * CHUNK, (i + 1) * CHUNK);
  const n = String(i + 1).padStart(2, '0');
  const id = `j-mixed-${n}`;
  const name = `Mixed Bag ${n}`;
  const style = 'One-off categories, thrown together';
  writeFileSync(`${OUT}/${id}.json`, JSON.stringify({ id, name, style, area: 'Jeopardy!', source: 'jarchive', cards }));
  decks.push({ id, name, style, area: 'Jeopardy!', count: cards.length, file: `decks/jeopardy/${id}.json` });
  inDecks += cards.length;
}

writeFileSync(`${OUT}/manifest.json`, JSON.stringify({
  local: 'Built from jwolle1/jeopardy_clue_dataset. Not for redistribution — personal study only.',
  decks,
}, null, 1));

console.log(`read ${read}, kept ${kept}`);
console.log(`dropped: ${Object.entries(dropped).map(([k, v]) => `${v} ${k}`).join(', ')}`);
console.log(`${decks.length} decks hold ${inDecks} clues`);
console.log(` one-off categories folded into the mixed decks; nothing left on the floor`);
