# Last Call

A spaced-repetition drill for pub trivia. It targets the categories a team habitually punts on rather than general knowledge, and it schedules each card by how well you knew it — missed cards come back today, easy ones vanish for weeks.

Static site. No build step, no framework, no backend. Open it and it runs.

## Run it

```
npx serve public          # or just open public/index.html
```

Progress lives in your browser (`localStorage`), with JSON export and import so you can move between phone and desktop. There are no accounts and nothing is sent anywhere.

## Checks

```
open public/index.html?selftest   # in-page assertions, prints PASS/FAIL
```

## The content rule

**No card whose answer decays.** Nothing phrased as "current champion", "most recent", "as of", "reigning", "youngest ever". A card that quietly goes wrong is worse than a missing card, because you will confidently give the wrong answer on a Thursday.

Contested answers keep the trap in the note field — Nile vs. Amazon, Abbey Road recorded-vs-released, Antarctic vs. Sahara. That is where quizzes are actually won.

## Where the questions come from

| Source | Licence | Notes |
|---|---|---|
| Hand-written originals | this repo, MIT | The starting deck |
| [Open Trivia Database](https://opentdb.com/) | CC BY-SA 4.0 | Verified questions only, attributed per card |
| Generated fact cards | facts, from Wikidata | Evergreen only — capitals, elements, anatomy |

Deck content sourced under CC BY-SA 4.0 stays under CC BY-SA 4.0. The code is MIT.

### On Jeopardy! clues

The best public clue corpus is [jwolle1/jeopardy_clue_dataset](https://github.com/jwolle1/jeopardy_clue_dataset), and its author explicitly asks that it not be used in public-facing sites or apps; the clues are the property of Jeopardy Productions, Inc.

So this repo ships a build script that pulls that corpus onto **your own machine** for personal drilling. Its output is gitignored and never deployed. The hosted site carries none of it. If you want that depth, run the script locally; please do not publish the result.

## Adding your own cards

Paste tab-separated lines into the drawer on the board: `category⇥question⇥answer⇥note`. A category you have not used before becomes your own. Cards you add are stored separately from the built-in deck, so rebuilding the deck never wipes them.

Cards from actual Thursday nights are worth more than anything pre-written.
