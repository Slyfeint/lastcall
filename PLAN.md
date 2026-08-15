# Last Call — plan to "official"

Working file. Each loop iteration: pick the topmost unchecked item, do it, verify it, commit it, tick it here. If an item turns out to be wrong, strike it and say why rather than silently dropping it.

**Repo:** `C:\Users\coliv\lastcall` → public `Slyfeint/lastcall` → Vercel.
**Shape:** static, no framework, no bundler. Plain HTML + ES modules + JSON decks. Node scripts for deck building only, run by hand, never at request time.
**Progress:** local-first. localStorage, JSON export/import. No accounts, no backend. Several people can share a phone, which is a switch on the device and not a sign-in — see "Not doing".

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
- [x] category browser that works at 834 categories: search across name+blurb+area, grouped by area, a dozen rows per area until you ask for more
- [x] typed-answer mode with forgiving matching (accents, case, punctuation, articles, plurals, Jeopardy phrasing, one typo in a long word); says "close" rather than deciding for you when you gave half a two-part answer
- [x] rabbit-hole mode: a Dive button per row drills that category alone, refilling instead of ending, without touching what is switched on; "Keep this card" copies it into your own cards so it outlives the deck
- [x] board mode: 6 categories x 5 values, easiest clue cheapest, right pays and wrong costs like the show, and it never touches your schedule
- [~] session shapes: six-round night with a running scorecard, and a final wager on the board (capped at what you hold). ~~picture round substitute~~ struck — there are no images in any deck, and inventing a stand-in round would be a different app, not a rehearsal of a real one
- [x] PWA: manifest + icons rendered in Chrome, service worker (network-first shell so deploys land, cache-first decks so an opened deck survives), verified by cutting the network in CDP and drilling anyway
- [x] keyboard and accessibility pass: every visible control has a name, rows report pressed state, the verdict is a live region, areas are headings, focus is visible, motion is optional, and contrast is measured against what is painted (copper was 3.88:1 and is now 4.61:1)

## Phase 4 — stats worth opening

- [x] session history, persisted — one compact row per session, capped so it cannot grow without bound
- [x] per-category accuracy (weakest first) and a recall forecast: a card reviewed one interval ago sits at 0.9 and decays from there
- [x] calendar heatmap, thirteen weeks, one validated amber ramp
- [x] leech board with the actual miss counts
- [x] one readiness number with its arithmetic printed underneath, counting a card you have never seen as one you do not know
- [x] all charts inline SVG, no chart library, one hue throughout, ramp validated against the walnut surface

## Phase 5 — proof

- [x] `npm test` = lint self-test + deck lint + a 150-check CDP suite: persistence, migration, ids, lazy loading, search, dive, keep, typed-answer judging, board, wager, night, PWA, offline, stats, a11y, keyboard, perf
- [~] every check demonstrated failing before it is trusted — done for the lint rules, ids, leech gate, refill, service worker, contrast, labels and the layout checks. The perf budget is the exception: on this desktop, throttled 4x, the fixed and regressed board draw in 33 ms and 63 ms, so the budget guards against gross regressions but does not separate those two. `scripts/perf.mjs` under mobile emulation does (37 ms against 602 ms), and that is where the claim lives
- [x] a11y pass: names on every visible control, pressed state, live region, headings, focus visible, reduced motion, and contrast computed from the painted colours (copper was 3.88:1, now 4.61:1)
- [x] performance measured, not assumed: cold load on a 4x-throttled phone paints the board in ~830 ms over 89 KB in 3 requests. The 8,000-card deck exposed an O(categories x cards) redraw — 602 ms, now 37 ms via a category index
- [x] every push verified against the deployed URL with the same suite, never assumed — it caught the broken Vercel build that 404'd every deck

## Phase 6 — the decks are deep enough, so fix the interface

Eleven categories sat under 90 cards, which is what made a night come round twice.

- [x] 1,431 hand-written cards in `house/<id>.json`, folded in by the OpenTDB build through the same lint and dedupe so a refetch can never lose them; every deck clears 150
- [x] 505 more in the house deck, taking its nine categories from ~23 each to ~80
- [x] decks revalidate in the service worker: they were cache-first, which pinned every deck and the manifest to the copy from your first visit, so new cards reached a returning browser never

## Phase 7 — the interface catches up with the decks

- [x] two checks that were passing on nothing: the per-area cap walked `.tap` when every row is wrapped in `.tap-row`, and the contrast loop could not see opacity, translucent backgrounds or svg fill. It was reporting a switched-off row at 6.16:1 while it painted at 2.63:1, and the zero due count at 1.57:1. Fixed by deleting the opacity, not by lowering the bar
- [x] design system: one red that is legible at 4.89:1 and the 2.69:1 one deleted, the three grades carrying their meaning at rest instead of on `:hover` a phone never has, no tint behind coloured text, seven mono sizes down to three, the section label declared once instead of four times, the heat ramp merged out of its own second `:root`, and every hover rule behind `@media(hover:hover)`
- [x] mobile, measured at 390px rather than argued from the CSS: the due count back, category accuracy as text that wraps instead of a drawing scaled to half size, no chart with type in it ever scaled below 0.95, 44px on every visible control, the game grid keeping its own sideways swipe, and 16px on the two fields iOS zooms into. Found that the mastery bar was an inline span and had never drawn at any width
- [x] the drill ends on something. It reports what it did to your schedule — never a score, because grading yourself *easy* is not getting it right and a missed card is asked twice in the same sitting. Kept in a Map that dies with the sitting rather than a field on `S`
- [x] the form guide can be acted on: every category bar drills that category, and the sticking points drill themselves
- [x] typing never moves other people's money — Enter on an empty box used to take a tile off a named person with no appeal — and the stake row says what the tile is worth instead of "+1"
- [x] the board explains itself: modes grouped with a caption each, games marked as leaving your schedule alone, a disabled control saying why where it is, one first-run paragraph derived from whether anything was ever drilled, and the tagline no longer overwritten by an inventory count one frame after it appears
- [x] several people, one phone: personal schedule/history/streak/typing, shared cards, decks and table record, one atomic key, `S` unchanged in shape, and a v3→v4 migration with the v1 chain still intact

## Not doing

- accounts, leaderboards, any backend. Local profiles are not an exception to this: there is no sign-in, no server and no network call, nothing is sent anywhere, and a backup is still a file you carry yourself. The test for whether something crosses the line is whether it leaves the device, not whether it has a name on it
- cross-device sync, which would need a merge basis `S` does not have — no device id, no per-field mtime, no counter. Restore is whole-blob and last-write-wins, and honest about it
- a framework or a bundler
- shipping Jeopardy clues to the public site
