# Diamond and Master ranked baselines

The ranked release is built from a frozen historical replay sample. The displayed
tiers are the anonymized source labels attached to each actual player slot.
They do not establish current rank, a particular season, or game-time rank.
Dates, rank timing, unique players, and player-balanced estimates are unavailable.

## Verified export status

The full selected population has been built as `ranked-hf-ef54ddc-v1` on
2026-11-03. Public-export and actual-consumer validation passed for all 54 gzip
shards, 6,344 exact aggregate rows, and 1,895 aggregate partitions. Both Diamond
and Master have samples for all 26 playable characters. The shard payload totals
10,562,606 compressed bytes; the manifest remains a separate small JSON file.
Independent full-source/cache reconciliation passed at 21:57 UTC on 2026-11-03.
The verified dataset is bundled in v0.5.0. Deployment evidence is recorded in the
[GitHub release](https://github.com/1973-pinball/SSBM_STATS/releases/tag/v0.5.0).

| Verified dataset measure | Count |
| --- | ---: |
| Complete source archives | 130 |
| Replay occurrences | 134,904 |
| Unique whole-file hashes | 111,132 |
| Repeated byte-identical copies | 23,772 |
| Equivalent metadata-wrapper duplicates | 0 |
| Accepted distinct games | 74,910 |
| Rejected games | 36,222 |
| Diamond player-games / distinct games | 55,993 / 49,404 |
| Master player-games / distinct games | 58,642 / 49,365 |

All exported tier sides have decided results: 27,178 Diamond
wins and 34,357 Master wins. The accepted games also contain 35,185 Platinum
opponent sides, retained in source evidence without a public Platinum baseline.
Tier distinct-game counts overlap and must not be summed. Rejection reasons can
overlap within one rejected game; their counts must not be summed either.

The manifest SHA-256, checked against the build and independent verification
receipts, is:

```text
735bd7dc96865c39ab98e538afcc95255bb517a384a4bf2d4e8c78131c864db0
```

The build receipt records zero new parses and reuse of all 111,132 inspected
files. Independent verification reconciled all source/member receipts, byte and
wrapper duplicate decisions, eligibility exclusions, actual-slot tiers, all
eight filter combinations, distinct-game/win counts, and every headline, action,
move, and interaction counter and measured-game/frame denominator. The local
report is `ranked-hf-ef54ddc-v1.verification.local.json`; it records
`publicationPerformed: false`. Production publication remains a separate step.

## Source and selection

Source: [erickfm/melee-ranked-replays at ef54ddc230e01373ff2a179b49a7e559af788081](https://huggingface.co/datasets/erickfm/melee-ranked-replays/tree/ef54ddc230e01373ff2a179b49a7e559af788081).
The mirror credits the anonymized Slippi ranked recordings associated with Fizzi;
[Slippi-AI](https://github.com/vladfi1/slippi-ai#acknowledgements) also credits
Fizzi, and [HAL](https://github.com/ericyuegu/hal#raw-replays) lists the six original
replay dumps. The mirror's dataset card declares MIT. That declaration is the
redistributor's metadata, not independent verification of the original dumps'
license. This release publishes aggregate numerical measurements, not replays.

The pinned tree contains 934 compressed archives totaling 1,429,762,524,410 bytes.
The selected population is **130 complete archives / 118,457,396,250 compressed
bytes**: the smallest archive in each of 26 character folders for each of
`diamond-diamond`, `master-master`, `master-diamond`, `diamond-platinum`, and
`master-platinum`. Equal sizes use path order. This is a deterministic convenience
sample chosen to cover every character/rank-pair stratum within local resources;
it is not random, character balanced, representative of the current ladder, or
the complete mirror. Character IDs and membership come from replay settings,
not the folder label. The frozen selection is in
[ranked-source-manifest.json](../scripts/data/ranked-source-manifest.json).

Each complete archive must match its pinned LFS byte count and SHA-256 before
ingestion. Streaming extraction keeps one bounded replay payload at a time and
rejects unsafe paths, links, malformed tar headers, and truncated gzip/tar data.
Downloaded archives and per-game audit/cache records stay outside the repository.

## Parser and eligibility

Stats version 10 fixes two pilot discrepancies. Missing-END recordings retain
the penultimate observed frame needed by slippi-js without inventing a winner.
Recordings that rewrite finalized history restart through the retained-frame
parser for correct headline statistics; their failed integrity evidence still
makes special attempts and interaction measurements unavailable. Ordinary
rollback continues through the bounded parser. The interaction detector version
remains 9, so the existing Tournament and Pro reference artifacts stay compatible.

Existing saved stats are preserved until replacement. Automatic background
updates cover the whole saved library when replay files are accessible,
independently of the active dashboard filters. Small batches use at most two
workers, retain progress through saved replacement versions, and avoid repeated
attempts on unavailable or failed files during the same visit. Background work
queries existing permission; reconnecting a folder grants access when needed.
The separate recent-interaction queue remains limited to its current window.
There is no destructive cache reset or database migration for the ranked release.

Publication requires supported human singles, legal stages, 30 seconds to
8 minutes plus 10 seconds,
four starting stocks, a resolved normal game end, contiguous pre/post frame
coverage for both actual slots, valid finalization evidence, bounded/retained
parser parity, and independent slippi-js headline/action checks. Missing-END,
LRAS/no-contest, short, incomplete, or contradictory recordings are excluded
and counted by rejection reason. The per-slot tier evidence must agree with the
unordered filename rank pair. A sorted filename pair never assigns player ports.

### Invalid upstream air-dodge counts

The full 130-archive inspection completed with 134,904 replay occurrences and
111,132 unique whole-file hashes. Before final metadata-wrapper deduplication,
321 player sides in 320 of the 75,230 otherwise eligible replay files had
negative air-dodge counts from slippi-js 9.1.2. The export excludes each affected
game in full, including its opponent, rather than clamping the count or using
partial action denominators. The audit exclusion covers 640 sides:
234 Diamond, 281 Master, and 125 Platinum. The completed build confirms the same
320 excluded games and 321 invalid side measurements after duplicate handling;
it found no equivalent metadata-wrapper duplicates. Independent reconciliation
confirmed these counts against the full source and cache.

The export rejection reason is `invalid-air-dodge-count`, applied when either
player's `actions.airDodges` is a negative safe integer. Other malformed action
counts, including missing or noninteger air-dodge counts, still stop export
validation. This gate runs before metadata-wrapper deduplication, so duplicate
equivalence also checks the same final eligibility decision. The public manifest
records `exportQualityVersion: ranked-export-quality-v1` and describes the gate.
Schema 1 retains complete base-metric coverage for every accepted player-game.
The cached replay inspections, parser fingerprint, and source recordings remain
unchanged; aggregation was rebuilt from the saved parses.

A synthetic reproduction demonstrated that the upstream action computer can
subtract an air dodge twice. It does not establish the exact trigger in each
affected recording. The detector is unchanged, and this negative-count gate
does not establish that every nonnegative count is correct. Exclusions are
concentrated in some characters, adding selection bias to an already nonrandom
sample; the result is not a representative ladder estimate.

Whole replay content hashes identify duplicate copies across character archives.
Files with identical raw command streams but different metadata wrappers count
once only after their sanitized metrics, tiers, and eligibility decisions agree;
any disagreement stops publication.
Repeated anonymous labels and missing dates are never treated as player or game
identity. Dittos preserve two player sides in the same tier; distinct-game counts
still count that replay once. Diamond/Master opponents can be Platinum without
creating a third public baseline in this release.

## Aggregation and delivery

One player-game means one eligible player side. Each row has its own distinct
game and decided-result counts. Exact character/opponent/stage cells, including
all-character or all-opponent totals, are aggregated directly from eligible sides.
The client selects one exact cell; it never sums overlapping subtotal rows or
falls back to a broader filter when a cell is absent.

Manifest `uniqueReplays` counts unique whole-file byte hashes. `duplicateCopies`
counts repeated identical files; `wrapperDuplicateCopies` counts validated
equivalent raw streams in distinct files. Accepted games + rejected games +
wrapper duplicates must equal unique replay files. Published tier side counts
are separate and can overlap in their distinct-game membership.

Headline/action/move coverage and interaction detector coverage remain separate.
Unavailable attempts and outcomes are omitted, while supported measurements with
zero occurrences remain measured zero. Community medians retain their existing
estimator and privacy thresholds; the ranked sample does not change consent,
private sync, or community publication rules.

The release uses a small `/ranked/manifest.json` and immutable, gzip-compressed
shards under `/ranked/<datasetId>/`. Only the selected character/tier shard is
fetched. Its compressed byte count and SHA-256 are checked before decompression,
then schema/parser versions and row shapes are validated. These files are opaque
`.json.gz` payloads, with no `Content-Encoding: gzip` response header. Versioned
files cache immutably; the current manifest revalidates. Ranked data is excluded
from the PWA precache and uses no Supabase credentials or database migration.

## Reproduce and publish

Run with Node 22 from the repository root. The committed source manifest fixes
the complete selection; downloads resume `.partial` files and publish a cached
archive only after hash verification. Keep at least 25 GB of additional free
space for parsing/audit artifacts.

For a managed run with periodic checkpoints, start the job once and use the
saved configuration for later resumes:

```powershell
npm run ranked:run -- --pause-after-archives 10
npm run ranked:status
npm run ranked:pause
npm run ranked:resume
```

The batch limit counts newly processed complete archives; validated cached
archives do not consume it. `ranked:pause` also works partway through an archive:
the builder drains its in-flight workers, saves their results, and closes the
source stream. Downloads stop cleanly and retain partial bytes for HTTP range
resume. No partial aggregate export is published. Wait for status `paused`
before closing the terminal or shutting down. Resume verifies the saved source
selection, reuses completed archive/member receipts and parsed records, and
continues the unfinished archive. Ctrl+C requests the same graceful pause.

`npm run ranked:resume -- --pause-after-archives 0` disables the batch limit.
The first `ranked:run` can set `--cache`, `--source-manifest`, `--dataset-id`,
`--output`, `--workers`, and `--concurrency`; resume preserves those exact
settings. The controller prevents simultaneous jobs for the same cache and
keeps logs and checkpoints there. A completed build is still separate from
verification and publication.

Progress reports show verified download bytes as a percentage of the pinned
118.5 GB selection. Processing percentage uses fully processed compressed source
volume, including reused receipts; it is a progress proxy, not a replay-count or
time-remaining estimate. Large archives can take longer between percentage jumps.
The unique replay count updates during an archive. Raw bytes and already parsed
records remain local across pauses.

On resume, the builder first revalidates cached archives and reloads their
receipts. Status keeps the previous drained checkpoint separate from the
current run's counters. Once fresh progress confirms the same pinned source
and parser identity, the overall completed-work figure stays at least as high
as that checkpoint while `phase: revalidating-cache` reports the smaller current
revalidation count. Before identity is confirmed, the old figure is labelled
historical rather than newly verified. Changed source/parser identities and
failed or orphaned runs cannot inherit that progress floor. Status commands
only read these records; the controller saves checkpoints at normal pauses.

The lower-level download/build commands are also available:

```powershell
$rankedCache = Join-Path $env:USERPROFILE '.cache/SSBM_DASHBOARD_ranked_baselines'
npm run ranked:download -- --cache "$rankedCache" --concurrency 6
npm run ranked:build -- --source-manifest scripts/data/ranked-source-manifest.json --cache "$rankedCache" --dataset-id ranked-hf-ef54ddc-v1 --workers 8 --output "$rankedCache/staged-v1" --download false
node --max-old-space-size=16384 scripts/verify-ranked-export.mjs --cache "$rankedCache" --export "$rankedCache/staged-v1"
npm run verify:ranked
```

Downloads and parsing can overlap by adding `--wait-downloads true` to the build.
Changing parser or replay-inspection gates invalidates the parse-cache
fingerprint; unchanged inputs reuse verified cache entries. Export eligibility
and aggregation changes require a rebuilt and independently verified export;
they do not rewrite the cached replay inspections. A later publication must use a new dataset
ID and retain previously published immutable assets. Stage and independently
verify the entire export before copying it into `public/ranked`, then pass the
repository checks and production build before pushing a release PR. Merge only
after required checks pass and verify the production manifest, compressed shard
hashes, filter behavior, and build ID after deployment.
