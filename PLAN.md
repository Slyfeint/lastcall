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

- [ ] `git init`, `.gitignore` (`.cache/`, `public/decks/jeopardy/`, `node_modules`), initial commit of the app as it stands
- [ ] `README.md`: what it is, how to run, deck sources and their licenses, the content rule, the Jeopardy carve-out stated plainly
- [ ] LICENSE for the code (MIT), separate attribution note for CC BY-SA deck content
- [ ] public repo `Slyfeint/lastcall`, pushed
- [ ] Vercel project, static, auto-deploy on push; confirm the live URL serves the app and `cards.js` loads
- [ ] smoke check against the deployed URL, not just localhost

## Phase 1 — ids and storage that survive a growing deck

This blocks everything after it. Today a card's id is `'k' + index`, so regenerating a deck silently reassigns every schedule.

- [ ] content-hash card ids (short base36 of the question text); one-time migration from `k<n>` for existing progress
- [ ] assert in the self-test that an id is stable when cards are inserted, removed and reordered
- [ ] measure the localStorage ceiling with 50k scheduled cards; compact the sched encoding (arrays, not objects) or move progress to IndexedDB, whichever the measurement demands
- [ ] progress must never be lost by a deck rebuild — schedules for cards that vanish are kept, not pruned

## Phase 2 — deck pipeline

- [ ] `scripts/build-opentdb.mjs`: session token, paged, 5s throttle, HTML entities decoded, deduped, mapped onto our category taxonomy, written to `public/decks/*.json` + `manifest.json`
- [ ] `scripts/lint-decks.mjs`: fails on decaying answers, empty fields, duplicate questions, answers longer than the question, mojibake. Wired into `npm test`
- [ ] `scripts/build-facts.mjs`: evergreen generated cards from Wikidata (capitals, borders, elements, planets, anatomy, mountains, rivers) with the source id on each card
- [ ] `scripts/build-jeopardy.mjs`: download the 76MB TSV to `.cache/`, filter media clues and decaying answers, bucket by category, write to the gitignored local deck dir. Documented as personal-use
- [ ] card provenance: every card carries its source, so the UI can say where a question came from and the SA obligation is honoured

## Phase 3 — the app for a big deck

- [ ] lazy category loading against the manifest, with a visible loading state
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

- [ ] `npm test`: deck lint + headless CDP suite (persistence, import round trip, id stability, lazy loading, typed-answer matching)
- [ ] every check demonstrated failing before it is trusted
- [ ] a11y pass: contrast, focus, labels, screen-reader names on the tap rows
- [ ] performance on a cold phone load with the largest deck
- [ ] the deployed URL verified after each push, not assumed

## Not doing

- accounts, leaderboards, any backend
- a framework or a bundler
- shipping Jeopardy clues to the public site
