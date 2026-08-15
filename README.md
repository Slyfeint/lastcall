# Last Call

A spaced-repetition drill for team trivia. It targets the categories a team habitually punts on rather than general knowledge, and it schedules each card by how well you knew it — missed cards come back today, easy ones vanish for weeks.

**[lastcall-kappa.vercel.app](https://lastcall-kappa.vercel.app)**

Static site. No framework, no bundler, no backend, no accounts. Progress lives in your browser and nothing is sent anywhere. Several people can share one phone — see [Whose turn it is](#whose-turn-it-is) — but that is a switch on the device, not a sign-in.

## What it does

**Drill** — the scheduler picks what is due, twenty a sitting unless you change it. Grade yourself missed / got it / easy, or switch on **Type the answers** and write them out. The judge forgives accents, case, punctuation, articles, plurals, "what is…" phrasing and one typo in a long word; when you give half of a two-part answer it says *close* and leaves the grade to you rather than deciding on your behalf. It ends by telling you what it did to your schedule — what went to bed, what comes round again today, when the next one is due. Not a score: grading yourself *easy* is not getting something right.

**The shelf** — twenty-three more categories beyond the house deck, fetched only when you switch one on. Search across the lot; each area shows a dozen until you ask for more.

**Dive** — drill one category as long as you like without changing what is switched on for tonight. It refills instead of ending. **Keep this card** copies anything you meet into your own cards, so it outlives the deck it came from.

**Play a board** — six categories, five clues, easiest at the top. Right pays its value, wrong costs it. Clear it in the black and you can wager on one last clue.

**Play the whole night** — six rounds of ten with a scorecard between them.

**The form guide** — one readiness number with its arithmetic printed underneath, thirteen weeks of drilling as a heatmap, accuracy session by session and category by category, and the cards that have beaten you five times. Every category bar is a button that drills it, because knowing your weakest subject and then having to go and find it was the long way round.

Games are games: a round, a board and a night never touch the schedule you have built up. Only a drill does. The board says so under every button.

### Whose turn it is

A table shares one phone, so the drill knows whose it is. Hit **Someone else's turn**, put in a name, and they get their own schedule, streak, history, sitting size and typing preference. Tap a chip to hand it back.

What everybody shares, and why: the cards you add, because a card's id is a hash of its question and the deck has to be identical for everybody or an id stops meaning the same card; which categories are switched on, because a switch would otherwise need a refetch and this has to work in a basement; and the table's record from the board game, because those were always other people's scores. Clearing progress clears whoever is holding the phone and leaves everybody else alone. A backup is the whole phone.

None of this is an account. There is no sign-in, no server and no network call — it is a switch on your own device, and a backup is still a file you carry yourself. Somebody who never hands the phone over sees nothing new at all.

### How it looks, and how it drills

A drawer on the board, with three groups in it. **Theme**: four presets — the warm dark it ships in, a cool dark, a warm light and a high-contrast light. **Type and text size**: the house faces, your device's own, or a serif — which changes the answers, the notes and the prose, because the question is set in the display face and stays there — at three sizes, which multiply the type and nothing else, so a 44px control is still 44px at the small step. **The drill**: how many cards a sitting deals, whether you type the answers, and whether a card you missed comes round again before the sitting ends.

The split is the same one as above. The look belongs to the phone: it lives in its own key outside anybody's progress, so it stays put when the phone changes hands and survives "Clear all progress". It is applied by a script in the head, before the first paint — the app's own load is async, and a theme read after that resolves means painting the dark one and repainting a moment later. The two drill knobs belong to whoever is holding the phone, so they ride the same per-person state as the schedule and the typing preference.

No type option adds a network request. The single `<link>` in the head fetches all three families whichever one you pick, and the device's own stack fetches nothing at all — a promise to work with no signal is not worth much if changing a setting reaches for a host the basement cannot serve.

## Run it

```
npm start                  # serves public/ on http://127.0.0.1:8080
```

Opening `public/index.html` straight off disk works too, but `fetch` is forbidden on `file://`, so you get the house deck only and the app says so.

Installable as a PWA. The shell is network-first so a deploy still reaches you; deck files are cache-first, so a deck you have opened once still works in a basement with no signal.

One known rough edge: the browser bar follows the theme you picked, but `manifest.webmanifest` is a static file, so its `background_color` and `theme_color` are the dark ones whatever you chose. An installed app on a light theme flashes the dark splash on a cold launch. There is no clean runtime fix worth one frame at launch, so it is written down rather than worked around.

## Checks

```
npm test                   # lint self-test + deck lint + the browser suite
npm run check:live         # the same suite against the deployed site
npm run perf               # cold load and big-deck timings, CPU throttled
open public/index.html?selftest   # in-page assertions, prints PASS/FAIL
```

`scripts/check.mjs` drives real Chrome over CDP: reload persistence, the schedule migration, lazy deck loading, search, typed-answer judging, the board and the wager, the night, the table and its hot seat, switching between people, offline with the network cut, the stats arithmetic, contrast sampled out of a screenshot of the running page, layout measured at a phone's width, and keyboard-only play. 392 assertions, each one demonstrated failing before it was trusted.

The contrast sweep runs once for each of the four themes rather than once for the one it ships in: twenty-nine text selectors apiece, 116 measured ratios, and the lowest two are copper's 4.61:1 in the default theme and 4.70:1 on a disabled button in Paper. The ink is still the computed colour composited through opacity, but the backdrop is no longer reasoned about — the element's own ink is made transparent, the page is photographed, and the pixels behind the glyphs are sampled, so the glow and the grain are counted instead of being assumed away. States that are never on the board at rest, a row mid-load and a disabled button, are forced on and measured with the rest.

Two of them were not, for a while. The per-area cap walked for the wrong element and counted nought for every area on the board, and the contrast loop read a text colour without its opacity — so a switched-off row was reported at 6.16:1 while it painted at 2.63:1. Both are fixed, and both were demonstrated failing afterwards.

The screenshot sweep found a third that is not fixed, because the fix is a design decision rather than a bug. The glow behind the masthead is a background layer that inherits `repeat`, so it re-paints every viewport-height down a 4,574px document, and a copper heading that lands in a lit band sits at about 4.2:1 rather than the 4.61:1 it gets on plain walnut. Which heading that is depends on the height of the phone: at 390×844, at 360×800 and at the harness's own size copper reads 4.61 everywhere, and at 412×915 the **more** button measures 4.13:1 and a section heading 4.47:1. It fails at 414×896 and 428×926 too, and it failed the same way before any of this work — the glow layer is older than the presets. The root cause is one `no-repeat` on that one gradient, which changes how the default theme looks, and lightening the colour is no way out — any copper still recognisable as copper tops out around 4.2 against the lit band. So nothing was changed and it is written down here.

## The content rule

**No card whose answer decays.** Nothing phrased as "current champion", "most recent", "as of", "reigning", "youngest ever". A card that quietly goes wrong is worse than a missing card, because you will confidently give the wrong answer when it counts.

`scripts/lint-decks.mjs` enforces it — and the importers call the same judgement, so a bad card never reaches a deck file. `npm run lint:selftest` proves every rule fires on a card built to trip it.

Contested answers keep the trap in the note field — Nile vs. Amazon, Abbey Road recorded-vs-released, Antarctic vs. Sahara. That is where quizzes are actually won.

## Where the questions come from

| Source | Licence | Notes |
|---|---|---|
| Hand-written originals | this repo, MIT | The house deck, 714 cards across 9 categories |
| Hand-written for the shelf | this repo, MIT | 1,426 more across 14 thin categories, folded in at build time from `house/` |
| [Open Trivia Database](https://opentdb.com/) | CC BY-SA 4.0 | 3,719 verified questions across 22 categories |
| The periodic table | facts | All 118 symbols, from a table that fails its own build if it is wrong |

5,977 cards in all. Every category clears 150, so a night's drilling does not come round twice.

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

Cards from games you actually played are worth more than anything pre-written.
