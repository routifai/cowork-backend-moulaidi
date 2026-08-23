## Responsibility

Small, dependency-free algorithms too tiny to justify an npm package. Currently one: Okapi BM25 text ranking.

## Key files

- `bm25.ts` — `rankBm25(query, documents: Bm25Document[]): Bm25Result[]`. Hand-rolled Okapi BM25 (`K1=1.5`, `B=0.75`) with a hardcoded English stopword list, over an in-memory corpus of at most a few hundred short documents. Tokenizes on `[^a-z0-9]+`, lowercases, drops stopwords. Returns every document sorted by descending score (including zero scores) — filtering to top-K / score > 0 is the caller's job.

## How it's invoked

Only consumer: `extensions/find-skill.ts`'s `findSkillExtension`, which builds `{ id: skill.name, text: `${name} ${description}` }` documents from `loadSkills()` output and ranks them against the model's `query` param, then filters `score > 0` and slices to top 5.

## Gotchas

- The stopword list explicitly includes verbs like "make"/"use"/"please" — added because a query like "make me a PowerPoint presentation" was ranking documents matching only filler words above the one actually about "powerpoint"/"presentation". If you see BM25 ranking odd results for a new use case, check whether the stopword list needs a use-case-specific addition (it was tuned for skill-search queries, not general text).
- Not shared/generalized on purpose — see the file's own comment: the corpus size (skill count) doesn't currently justify pulling in a real search library. If a second consumer appears with a much larger corpus, reconsider.
