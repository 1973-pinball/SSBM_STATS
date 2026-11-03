# Ranked source pilot

Audited 2026-11-03. The initial audit found four bounded/retained parser parity
failures among 13 recordings. **Those parser discrepancies are now fixed in
stats version 10:** all 13 recordings agree across both parser paths. The
missing-END and invalid-finalization recordings still fail ranked publication
eligibility; correcting their headline stats does not make them complete games.
This document preserves the initial observations below. The production pipeline
and larger source selection are documented in the
[ranked release guide](ranked-baselines-release.md).

## Source and reproduction

The raw replay mirror is
[erickfm/melee-ranked-replays, revision ef54ddc230e01373ff2a179b49a7e559af788081](https://huggingface.co/datasets/erickfm/melee-ranked-replays/tree/ef54ddc230e01373ff2a179b49a7e559af788081).
The pilot pins four shards, verifies their byte sizes and SHA-256 values against
the revision's Hugging Face tree API/LFS metadata, and checks downloaded bytes
before inspecting tar entries. Extraction rejects links and unsafe paths and
stores each replay under its content hash.

| Shard | Compressed bytes | Replay entries |
| --- | ---: | ---: |
| `BOWSER/BOWSER_master-master_a2.tar.gz` | 2,000,229 | 1 |
| `PICHU/PICHU_master-master_a3.tar.gz` | 3,222,139 | 4 |
| `PICHU/PICHU_diamond-diamond_a6.tar.gz` | 3,380,219 | 3 |
| `PICHU/PICHU_master-diamond_a6.tar.gz` | 5,086,385 | 5 |

Run from the repository root:

```powershell
node scripts/verify-ranked-source-pilot.mjs
node scripts/ranked-source-pilot.mjs
node scripts/verify-parse.mjs "$HOME/.cache/SSBM_DASHBOARD_ranked_pilot/ef54ddc230e01373ff2a179b49a7e559af788081/replays" 13
```

The last command now passes all 13 parity comparisons after the v10 fixes.
The first command checks pure rank, deduplication, safe archive handling and
completeness boundaries without network access. The pilot downloads at most
15 MB of replay archives and reuses verified cached files on rerun. An alternate
cache can be passed as `--cache DIRECTORY`.

Default local artifacts are under
`~/.cache/SSBM_DASHBOARD_ranked_pilot/ef54ddc230e01373ff2a179b49a7e559af788081/`:
`source-manifest.json`, pinned `hf-tree-*.json` receipts, the source dataset
card, `replay-occurrences.ndjson`, `replay-audit.ndjson`, `summary.json`, and
`audit.md`. Per-replay audits retain exact parser differences and missing
measurements. Raw replays and working evidence remain local.

## Observed membership and identity

All 13 files parsed, yielding 26 player sides: **15 Master and 11 Diamond**.
Per-slot game-start names are exactly `Master Player` or `Diamond Player`;
slippi-js exposes these netplay names as `settings.players[].displayName`.
All five mixed-tier games contain one of each. Diamond occupies the first
player slot in three of them, so sorted filename rank pairs cannot assign sides.
Filename pairs are only an unordered consistency check; unknown or conflicting
per-side evidence is excluded.

All metadata objects are empty. Dates, season and rank timing are unknown;
these are historical source labels, not current or established game-time ranks.
Repeated anonymous labels do not establish player identity, unique players,
or player-balanced estimates. Full parses recover frame counts from gameplay;
header previews report zero duration and no winner for all 13.

The sample covers seven characters and four legal stages. Character IDs remain
the dashboard's external Slippi IDs, including Bowser 5 and Pichu 24; there is
no libmelee/internal-ID conversion. All 13 content hashes and raw-command-stream
hashes are distinct. This selection contains no dittos or overlapping character
copies, so real ditto behavior and cross-shard duplicates still need validation.
Content hashing is implemented; a cross-encoding game identity is not established.

## Completeness and measurement coverage

All retained frame sequences are contiguous and contain both sides' pre/post
updates. Nevertheless, terminal and raw finalized-frame evidence matters:

- Three files have no game-end event. Winners correctly remain unknown even
  though a player reaches zero stocks. Their bounded/retained parser difference
  is `stocksRemaining` for both sides.
- `master-master-645ec226c4386222583756c1.slp` is a heavy-rollback quit-out. The
  existing finalized-frame integrity guard fails. Special attempts and
  interactions remain unavailable for both sides, while bounded/retained
  headline and move statistics disagree extensively. Retained frame continuity
  alone would not detect this problem.
- Nine games agree across both parser paths and pass the pilot's conservative
  terminal/frame/tier gate: **18 provisional sides, 7 Master and 11 Diamond**.
  These are audit candidates only, not approved production rows.

| Measurement | Present in all audited sides (26) | Caveat |
| --- | ---: | --- |
| Headline stats, actions, move rows and normal attempts | 26 | Heavy-rollback game's two sides disagree with retained parsing |
| L-cancel and damage parity with slippi-js | 24 | Two heavy-rollback sides fail |
| Special attempt counts, each direction | 24 | Two sides unavailable, never measured zero |
| Special outcome triples: neutral / side / up / down | 5 / 22 / 8 / 12 | Character capability and measurement coverage differ |
| Defensive interactions | 24 | Guarded completeness |
| Recovery interactions | 20 | Additional detector coverage restrictions |
| Punish context | 24 | Guarded completeness |
| Decided game winners | 10 of 13 games | Includes quit-out; three missing-end games remain unknown |

Do not use any of these counts as a publishable denominator until the game-level
gate and the metric's own availability checks both pass. Within the 18 provisional
sides, specials remain separately qualified by capability and recovery remains
unavailable for two sides. The source is promising for baseline and interaction
analysis, but this pilot does not establish parity for full ingestion.

## Resources and next bounded step

The four downloads total **13,688,972 bytes**; unique replay payloads total
**63,141,604 bytes**. Expanded tar payloads total 63,191,040 bytes and are processed
in memory, while archives plus extracted replay files consume about 76.8 MB on
disk before small receipts. The sampled full parser took about **2.7 seconds**
for 13 games in one process; the cached audit, including separate library and
retained-parser passes, took about 9 seconds. Timings vary by machine and cache.

A linear illustration per 1,000 similar games is roughly **1.05 GB compressed,
4.86 GB extracted, and 3.5 minutes of full parsing**. These 13 games are a tiny,
deliberately selected Bowser/Pichu shard sample. This is not a full-corpus
forecast: duration, duplication across character buckets, output/index space,
download rate and concurrency have not been estimated representatively.

The next implementation phase should isolate the three missing-end fixtures and
the raw finalized-frame rewrite fixture, resolve or explicitly reject their
parser discrepancies with regression evidence, then repeat a bounded sample
that includes actual dittos and matching games from different shards. Do not
weaken completeness guards or infer missing winners, dates or tiers to increase
coverage. Parser changes require a separate measurement/cache version review.

The [mirror's pinned card](https://huggingface.co/datasets/erickfm/melee-ranked-replays/blob/ef54ddc230e01373ff2a179b49a7e559af788081/README.md)
labels its redistribution MIT; that label does not establish the original dumps'
terms. [Slippi-AI credits Fizzi](https://github.com/vladfi1/slippi-ai#acknowledgements)
for the anonymized ranked source and [HAL lists the raw dumps](https://github.com/ericyuegu/hal#raw-replays).
Confirm original release terms and preserve attribution before publication.
Rank timing remains unresolved independently of parser compatibility.
