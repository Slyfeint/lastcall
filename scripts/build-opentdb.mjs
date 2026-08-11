/* Turns the cached Open Trivia DB pages into deck files the app can lazy-load.

   Run scripts/fetch-opentdb.mjs first. This step is offline and instant, so
   re-run it freely while tuning the filters.

   node scripts/build-opentdb.mjs
*/
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { check } from './lint-decks.mjs';

const CACHE = '.cache/opentdb';
const OUT = 'public/decks';

if (!existsSync(CACHE)) { console.error(`No cache. Run: node scripts/fetch-opentdb.mjs`); process.exit(2); }

/* Their category ids, given our voice. Areas group the board so 30 taps stay
   browsable. Anything not listed here is skipped rather than dumped in a bin. */
const CATS = {
  9:  ['gen',   'General Knowledge',   'The stuff that shows up in every round', 'House'],
  10: ['books', 'Books',               'Novels, poets, and who wrote which one', 'Page'],
  11: ['film',  'Film',                'Directors, casts, and the line everyone quotes', 'Screen'],
  12: ['music', 'Music',               'Every era, not just the vinyl one', 'Sound'],
  13: ['stage', 'Stage & Musicals',    'Curtain up — Broadway, the West End, the score', 'Sound'],
  14: ['tv',    'Television',          'Series, casts, and the show that ran too long', 'Screen'],
  15: ['games', 'Video Games',         'Consoles, studios, and the one with the plumber', 'Play'],
  16: ['board', 'Board Games',         'Pieces, rules, and the box everyone owns', 'Play'],
  17: ['nature','Science & Nature',    'Chemistry, weather, and the things outside', 'Science'],
  18: ['comp',  'Computers',           'Languages, protocols, and the machines', 'Science'],
  19: ['math',  'Mathematics',         'Numbers, shapes, and the proofs with names', 'Science'],
  20: ['mythos','World Mythology',     'Gods beyond the Greek and Roman set', 'World'],
  21: ['sport', 'Sports',              'Rules, records, and who lifted what', 'Play'],
  22: ['world', 'Geography',           'Beyond capitals — flags, rivers, borders', 'World'],
  23: ['hist',  'History',             'Dates, treaties, and who was on which side', 'World'],
  24: ['pol',   'Politics',            'Offices, parties, and how a bill moves', 'World'],
  25: ['art2',  'Art & Design',        'Movements, buildings, and the people behind them', 'Page'],
  26: ['fame',  'Celebrities',         'Names, faces, and the tabloid decades', 'Screen'],
  27: ['fauna', 'Animals',             'Species, collective nouns, and the odd beak', 'Science'],
  28: ['wheels','Vehicles',            'Cars, planes, ships, and the engines in them', 'Play'],
  29: ['comics','Comics',              'Panels, publishers, and secret identities', 'Screen'],
  31: ['anime', 'Anime & Manga',       'Studios, series, and the long-running ones', 'Screen'],
  32: ['toons', 'Cartoons',            'Animation, from Saturday morning onward', 'Screen'],
};

const b64 = s => Buffer.from(s, 'base64').toString('utf8');
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const DIFF = { easy: 1, medium: 2, hard: 3 };

/* Things the lint has no opinion on, because they are peculiar to this source:
   clues that point at media the API does not give us. */
const MEDIA = /\b(this|these|the following) (image|picture|photo|logo|screenshot|song|clip|video)\b/i;

const decks = new Map();
const seen = new Set();
let read = 0, kept = 0;
const dropped = { boolean: 0, dupe: 0, short: 0, media: 0, uncategorised: 0 };
const rejected = {};   // by the lint's own reason, so the tally names what the rules cost

for (const file of readdirSync(CACHE)) {
  if (!file.startsWith('cat-')) continue;
  const catId = +file.slice(4).split('-')[0];
  const meta = CATS[catId];
  for (const row of JSON.parse(readFileSync(`${CACHE}/${file}`, 'utf8'))) {
    read++;
    if (!meta) { dropped.uncategorised++; continue; }
    if (b64(row.type) === 'boolean') { dropped.boolean++; continue; }   // useless as a recall card
    const q = b64(row.question).trim();
    const a = b64(row.correct_answer).trim();
    if (q.length < 12 || !a) { dropped.short++; continue; }
    if (MEDIA.test(q)) { dropped.media++; continue; }
    const why = check({ q, a });
    if (why) { rejected[why] = (rejected[why] || 0) + 1; continue; }
    const k = norm(q);
    if (seen.has(k)) { dropped.dupe++; continue; }
    seen.add(k);
    if (!decks.has(meta[0])) decks.set(meta[0], []);
    decks.get(meta[0]).push({ q, a, d: DIFF[b64(row.difficulty)] || 2, s: 'otdb' });
    kept++;
  }
}

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const [id, name, style, area] of Object.values(CATS)) {
  const cards = decks.get(id);
  if (!cards?.length) continue;
  cards.sort((x, y) => x.d - y.d || x.q.localeCompare(y.q));   // stable order, easy first
  writeFileSync(`${OUT}/${id}.json`, JSON.stringify({ id, name, style, area, source: 'opentdb', cards }));
  manifest.push({ id, name, style, area, count: cards.length, file: `decks/${id}.json` });
}
console.log(`read ${read}, kept ${kept} across ${manifest.length} decks`);
console.log(`dropped: ${Object.entries(dropped).map(([k, v]) => `${v} ${k}`).join(', ')}`);
for (const [why, n] of Object.entries(rejected).sort((a, b) => b[1] - a[1])) console.log(`  ${n} rejected — ${why}`);
