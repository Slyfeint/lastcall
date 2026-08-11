# Last Call — plan to "official"

Working file. Each loop iteration: pick the topmost unchecked item, do it, verify it, commit it, tick it here. If an item turns out to be wrong, strike it and say why rather than silently dropping it.

**Repo:** `C:\Users\coliv\lastcall` → public `Slyfeint/lastcall` → Vercel.
**Shape:** static, no framework, no bundler. Plain HTML + ES modules + JSON decks. Node scripts for deck building only, run by hand, never at request time.
**Progress:** local-first. localStorage, JSON export/import. No accounts, no backend.

## Decisions already made

- Deck scale: large, lazy-loaded per category from a manifest.
- Public deck sources, in order of trust: hand-written originals (the 209 that exist), Open Trivia DB (CC BY-SA 4.0, ~5.3k verified, attributed), generated evergreen fact cards from Wikidata (facts, not expression).
- Jeopardy: the 554k-clue J-Archive mirror asks not to be used in public-facing apps. So the build script for it lives in the repo, its output is gitignored, and it never ships to Vercel. Personal drilling only.
- Content rule, enforced by a linter, not by vigilance: no answer that decays. No "current", "most recent", "as of", "today", "reigning", "youngest ever". A card that quietly goes wrong is worse than a missing card.

---

## Phase 0 — repo and deploy skeleton

- [x] `git init`, `.gitignore` (`.cache/`, `public/decks/jeopardy/`, `node_modules`), initial commit of the app as it stands
- [x] `README.md`: what it is, how to run, deck sources and their licenses, the content rule, the Jeopardy carve-out stated plainly
- [x] LICENSE for the code (MIT), separate attribution note for CC BY-SA deck content
- [x] public repo `Slyfeint/lastcall`, pushed
- [x] Vercel project, static, auto-deploy on push; confirm the live URL serves the app and `cards.js` loads
- [x] smoke check against the deployed URL, not just localhost

## Phase 1 — ids and storage that survive a growing deck

This blocks everything after it. Today a card's id is `'k' + index`, so regenerating a deck silently reassigns every schedule.

- [x] content-hash card ids (short base36 of the question text); one-time migration from `k<n>` for existing progress
- [x] assert in the self-test that an id is stable when cards are inserted, removed and reordered
- [x] measure the localStorage ceiling with 50k scheduled cards; compact the sched encoding (arrays, not objects) or move progress to IndexedDB, whichever the measurement demands
- [x] progress must never be lost by a deck rebuild — schedules for cards that vanish are kept, not pruned

## Phase 2 — deck pipeline

- [x] `scripts/fetch-opentdb.mjs` + `scripts/build-opentdb.mjs`: session token, paged, 5s throttle, base64 to dodge entity soup, deduped, mapped onto a 23-category taxonomy with areas
- [x] `scripts/lint-decks.mjs`: fails on decaying answers, empty fields, duplicate questions, swapped fields, mojibake, orphaned multiple-choice. `--selftest` proves every rule fires. Exported so importers reject at the door
- [x] `scripts/build-manifest.mjs`: one manifest over whatever decks exist, so each builder writes only its own file
- [~] ~~`scripts/build-facts.mjs` from Wikidata~~ — struck. Capitals/borders/rivers would have duplicated the house Geography deck for real accuracy risk, and REST Countries v3 is deprecated. Replaced by `scripts/build-elements.mjs`: all 118 symbols from an embedded table that fails the build if it is wrong. Revisit only if a category turns out to be thin
- [x] `scripts/build-jeopardy.mjs`: 76MB TSV to `.cache/`, clue and response swapped the right way round, media and decaying clues filtered, 802 decks, gitignored and never deployed
- [x] card provenance: every card carries `s` (otdb / table / jarchive / house) and the manifest carries the licence per source

## Phase 3 — the app for a big deck

- [x] lazy category loading against the manifest, with a visible loading state
- [ ] category browser that works at 40+ categories: search, group by area, subcategory rabbit holes
- [ ] typed-answer mode with forgiving matching (articles, punctuation, "the", accents, plural) — the mode that actually prepares you for a real answer sheet
- [ ] rabbit-hole mode: pick a topic, get an endless related run, with the option to bank a card into your own deck
- [ ] Jeopardy-style board mode: 6 categories, 5 values, pick your way across
- [ ] session shapes that match a real night: six rounds, a picture round substitute, a final wager
- [ ] PWA: offline, installable, phone-first drilling
- [ ] keyboard-first everywhere; audit focus order and reduced motion

## Phase 4 — stats worth opening

- [ ] session history, persisted
- [ ] per-category accuracy over time and a retention forecast ("what you would score tonight")
- [ ] calendar heatmap of drilling
- [ ] leech board with the actual miss counts
- [ ] a single honest readiness number, with the arithmetic shown
- [ ] all charts inline SVG, no chart library, readable in the bar-room palette

## Phase 5 — proof

- [~] `npm test`: headless CDP suite in place (persistence, migration, import round trip, id stability). Still to add: deck lint, lazy loading, typed-answer matching
- [ ] every check demonstrated failing before it is trusted
- [ ] a11y pass: contrast, focus, labels, screen-reader names on the tap rows
- [ ] performance on a cold phone load with the largest deck
- [ ] the deployed URL verified after each push, not assumed

## Not doing

- accounts, leaderboards, any backend
- a framework or a bundler
- shipping Jeopardy clues to the public site
