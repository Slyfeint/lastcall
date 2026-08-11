# Last Call

A spaced-repetition drill for pub trivia. It targets the categories a team habitually punts on rather than general knowledge, and it schedules each card by how well you knew it — missed cards come back today, easy ones vanish for weeks.

**[lastcall-kappa.vercel.app](https://lastcall-kappa.vercel.app)**

Static site. No framework, no bundler, no backend, no accounts. Progress lives in your browser and nothing is sent anywhere.

## What it does

**Drill** — the scheduler picks what is due, twenty per sitting. Grade yourself missed / got it / easy, or switch on **Type the answers** and write them out. The judge forgives accents, case, punctuation, articles, plurals, "what is…" phrasing and one typo in a long word; when you give half of a two-part answer it says *close* and leaves the grade to you rather than deciding on your behalf.

**The shelf** — twenty-three more categories beyond the house deck, fetched only when you switch one on. Search across the lot; each area shows a dozen until you ask for more.

**Dive** — drill one category as long as you like without changing what is switched on for tonight. It refills instead of ending. **Keep this card** copies anything you meet into your own cards, so it outlives the deck it came from.

**Play a board** — six categories, five clues, easiest at the top. Right pays its value, wrong costs it. Clear it in the black and you can wager on one last clue.

**Play the whole night** — six rounds of ten with a scorecard between them, which is the shape a real Thursday has.

**The form guide** — one readiness number with its arithmetic printed underneath, thirteen weeks of drilling as a heatmap, accuracy session by session and category by category, and the cards that have beaten you five times.

Games are games: a round, a board and a night never touch the schedule you have built up. Only a drill does.

## Run it

```
npm start                  # serves public/ on http://127.0.0.1:8080
```

Opening `public/index.html` straight off disk works too, but `fetch` is forbidden on `file://`, so you get the house deck only and the app says so.

Installable as a PWA. The shell is network-first so a deploy still reaches you; deck files are cache-first, so a deck you have opened once still works in a basement with no signal.

## Checks

```
npm test                   # lint self-test + deck lint + the browser suite
npm run check:live         # the same suite against the deployed site
npm run perf               # cold load and big-deck timings, CPU throttled
open public/index.html?selftest   # in-page assertions, prints PASS/FAIL
```

`scripts/check.mjs` drives real Chrome over CDP: reload persistence, the schedule migration, lazy deck loading, search, typed-answer judging, the board and the wager, the night, offline with the network cut, the stats arithmetic, contrast computed from the painted colours, and keyboard-only play. Roughly 150 assertions, each one demonstrated failing before it was trusted.

## The content rule

**No card whose answer decays.** Nothing phrased as "current champion", "most recent", "as of", "reigning", "youngest ever". A card that quietly goes wrong is worse than a missing card, because you will confidently give the wrong answer on a Thursday.

`scripts/lint-decks.mjs` enforces it — and the importers call the same judgement, so a bad card never reaches a deck file. `npm run lint:selftest` proves every rule fires on a card built to trip it.

Contested answers keep the trap in the note field — Nile vs. Amazon, Abbey Road recorded-vs-released, Antarctic vs. Sahara. That is where quizzes are actually won.

## Where the questions come from

| Source | Licence | Notes |
|---|---|---|
| Hand-written originals | this repo, MIT | The house deck, 209 cards |
| [Open Trivia Database](https://opentdb.com/) | CC BY-SA 4.0 | 3,719 verified questions across 22 categories |
| The periodic table | facts | All 118 symbols, from a table that fails its own build if it is wrong |

Deck content sourced under CC BY-SA 4.0 stays under CC BY-SA 4.0. The code is MIT.

```
npm run fetch:otdb         # harvest the API, cached and resumable, ~10 min
npm run decks              # rebuild the deck files and the manifest
```

### On Jeopardy! clues

The best public clue corpus is [jwolle1/jeopardy_clue_dataset](https://github.com/jwolle1/jeopardy_clue_dataset), and its author explicitly asks that it not be used in public-facing sites or apps; the clues are the property of Jeopardy Productions, Inc.

So `npm run build:jeopardy` pulls that corpus onto **your own machine** — 530,000 clues across 800 categories, clue on the front and response on the back. Its output is gitignored and never deployed, and the app merges it only if it finds it locally. The hosted site carries none of it. Please do not publish the result.

## Adding your own cards

Paste tab-separated lines into the drawer on the board: `category⇥question⇥answer⇥note`. A category you have not used before becomes your own. Cards you add are stored separately from the built-in deck, so rebuilding a deck never wipes them, and "Clear all progress" leaves them alone.

Cards from actual Thursday nights are worth more than anything pre-written.
