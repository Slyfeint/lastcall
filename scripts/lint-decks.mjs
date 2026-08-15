/* The content rule, enforced instead of remembered.

   A card whose answer decays is worse than no card: you will confidently give
   last year's answer when it counts. This fails the build on that, and on the
   other ways a bulk-imported card goes wrong.

   node scripts/lint-decks.mjs
*/
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/* Each rule gets the card and returns a complaint, or nothing. Kept as plain
   regexes with a note, because the next person to add one is reading this in
   a hurry. */
const DECAY = [
  [/\bas of\b/i,                          'says "as of"'],
  [/\bcurrently\b/i,                      'says "currently"'],
  // "current" decays, except the physics one: electric, ocean, air currents
  [/(?<!\b(electric|electrical|alternating|direct|ocean|air|water|convection|eddy|rip|jet)\s)\bcurrent\b/i, 'says "current"'],
  [/\bmost recent\b/i,                    'says "most recent"'],
  [/\breigning\b/i,                       'says "reigning"'],
  [/\b(to date|so far|thus far)\b/i,      'says "to date"'],
  [/\b(nowadays|these days|at present|right now)\b/i, 'anchored to now'],
  [/\bthe latest\b/i,                     'says "the latest"'],
  [/\b(youngest|oldest|first|last) [a-z ]*\bever\b/i, 'an "ever" superlative that a new record breaks'],
  [/\b(holds|has) the record\b/i,         'a record that can be broken'],
  [/,\s*with (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i, 'a tally that ticks up'],
  [/\b(still|currently) (alive|living|in office|in print|on the air|married)\b/i, 'a state that changes'],
];

const RULES = [
  c => !c.q?.trim() && 'empty question',
  c => !c.a?.trim() && 'empty answer',
  c => c.q?.length > 300 && 'question over 300 chars',
  c => /&[a-z]+;|&#\d+;/i.test(c.q + c.a) && 'undecoded HTML entity',
  c => /�|Ã.|Â./.test(c.q + c.a) && 'mojibake',
  c => /which of the (following|these)|of the following|all of the above|none of the above/i.test(c.q)
       && 'multiple-choice phrasing with no choices to show',
  c => /^(true or false|true\/false)/i.test(c.q.trim()) && 'true/false, useless as a recall card',
  // a genuine swap looks like a question sitting in the answer field; long
  // list answers ("the four Grand Slams") are fine and common
  c => /\?\s*$/.test(c.a) && !/\?\s*$/.test(c.q) && 'the answer is phrased as the question — swapped?',
  c => { for (const [re, why] of DECAY) if (re.test(c.q) || re.test(c.a)) return `decays: ${why}`; },
];

/* The one place a card is judged. Importers call this too, so a rejected card
   never reaches a deck file in the first place and the lint stays a backstop. */
export const check = c => { for (const rule of RULES) { const why = rule(c); if (why) return why; } };

const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/lint-decks.mjs');
if (!isCli) { /* imported for `check` only */ }
else if (process.argv.includes('--selftest')) {
  // A lint nobody has seen fail is a lint nobody should trust.
  const bad = [
    ['The current world champion', 'Someone'],
    ['The most recent host city', 'Somewhere'],
    ['The tallest building as of 2019', 'A tower'],
    ['The reigning monarch', 'Someone'],
    ['The youngest person ever to win it', 'Someone'],
    ['The country with the most titles', 'Brazil, with five'],
    ['Holds the record for most goals', 'Someone'],
    ['Which of the following is a fruit', 'Apple'],
    ['True or false: the sky is blue', 'True'],
    ['Who wrote &quot;Hamlet&quot;', 'Shakespeare'],
    ['', 'No question'],
    ['A question', ''],
    ['Shakespeare', 'Who wrote Hamlet?'],
  ];
  const good = [
    ['The four tennis Grand Slam tournaments', 'The Australian Open, the French Open, Wimbledon, and the US Open'],
    ['The only one of the Seven Wonders of the Ancient World that survives', 'The Great Pyramid of Giza'],
    ['The unit of electric current', 'The ampere'],
    ['Painted "The Starry Night"', 'Vincent van Gogh'],
  ];
  let f = 0;
  for (const [q, a] of bad) {
    const why = check({ q, a });
    if (!why) { f++; console.log(`MISSED  ${q} / ${a}`); } else console.log(`caught  ${why}  <- ${q || '(empty)'}`);
  }
  for (const [q, a] of good) {
    const why = check({ q, a });
    if (why) { f++; console.log(`FALSE POSITIVE  ${why}  <- ${q}`); }
  }
  console.log(`\n${f ? f + ' RULE FAILURES' : `all ${bad.length} bad cards caught, all ${good.length} good cards passed`}`);
  process.exit(f ? 1 : 0);
}

else lintEverything();

function loadDeck(path) {
  if (path.endsWith('.js')) {
    const src = readFileSync(path, 'utf8');
    return { name: path, cards: new Function(`${src}; return CARDS;`)() };
  }
  const d = JSON.parse(readFileSync(path, 'utf8'));
  return { name: `${path} (${d.name})`, cards: d.cards };
}

function lintEverything() {
const files = [];
if (existsSync('public/cards.js')) files.push('public/cards.js');
for (const dir of ['public/decks']) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && f !== 'manifest.json') files.push(`${dir}/${f}`);
}

const seen = new Map();
let bad = 0, total = 0;

for (const file of files) {
  const { name, cards } = loadDeck(file);
  for (const c of cards) {
    total++;
    const why = check(c);
    if (why) { bad++; console.log(`${name}\n  ${why}\n  Q: ${c.q}\n  A: ${c.a}\n`); }
    const k = norm(c.q);
    if (seen.has(k) && seen.get(k) !== file) {
      bad++;
      console.log(`${name}\n  duplicate of a card in ${seen.get(k)}\n  Q: ${c.q}\n`);
    } else seen.set(k, file);
  }
}

console.log(`${total} cards across ${files.length} file(s) — ${bad ? bad + ' rejected' : 'clean'}`);
process.exit(bad ? 1 : 0);
}
