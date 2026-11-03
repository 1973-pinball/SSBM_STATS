# Diamond and Master ranked baselines

The ranked release is built from a frozen historical replay sample. The displayed
tiers are the anonymized source labels attached to each actual player slot.
They do not establish current rank, a particular season, or game-time rank.
Dates, rank timing, unique players, and player-balanced estimates are unavailable.

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

Existing compatible local stats are preserved until replacement. Explicit
Refresh/Reconnect reparses older parser versions, and the recent automatic
analysis window also upgrades them. There is no destructive cache reset or
database migration for the ranked release.

Publication requires supported human singles, legal stages, 30 seconds to
8 minutes plus 10 seconds,
four starting stocks, a resolved normal game end, contiguous pre/post frame
coverage for both actual slots, valid finalization evidence, bounded/retained
parser parity, and independent slippi-js headline/action checks. Missing-END,
LRAS/no-contest, short, incomplete, or contradictory recordings are excluded
and counted by rejection reason. The per-slot tier evidence must agree with the
unordered filename rank pair. A sorted filename pair never assigns player ports.

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

```powershell
$rankedCache = Join-Path $env:USERPROFILE '.cache/SSBM_DASHBOARD_ranked_baselines'
npm run ranked:download -- --cache "$rankedCache" --concurrency 6
npm run ranked:build -- --source-manifest scripts/data/ranked-source-manifest.json --cache "$rankedCache" --dataset-id ranked-hf-ef54ddc-v1 --workers 8 --output "$rankedCache/staged-v1" --download false
node --max-old-space-size=16384 scripts/verify-ranked-export.mjs --cache "$rankedCache" --export "$rankedCache/staged-v1"
npm run verify:ranked
```

Downloads and parsing can overlap by adding `--wait-downloads true` to the build.
Changing parser/gate source invalidates its parse-cache fingerprint; unchanged
files reuse verified cache entries. A later publication must use a new dataset
ID and retain previously published immutable assets. Stage and independently
verify the entire export before copying it into `public/ranked`, then pass the
repository checks and production build before pushing a release PR. Merge only
after required checks pass and verify the production manifest, compressed shard
hashes, filter behavior, and build ID after deployment.
