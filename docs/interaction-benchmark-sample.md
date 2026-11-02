# Experimental interaction references — 0.4.9

The shipped reference reparses 10,536 unique singles games from 66 public replay
bundles using the same corrected stats-version-8 detectors as local imports.
It is a convenience sample, not an estimate of the whole Melee population.

| Cohort | Games | Player appearances | Ledge / OOS coverage | Recovery / edgeguard coverage | Opening-context coverage |
| --- | ---: | ---: | ---: | ---: | ---: |
| Venue | 6,327 | 12,654 | 12,050 | 11,188 | 12,650 |
| Tournament | 4,640 | 9,280 | 8,868 | 8,236 | 9,280 |
| Pro | 613 | 702 | 702 | 620 | 702 |

Coverage columns count measured player appearances. Older or incomplete
recordings can lack required fields, and recovery and edgeguard coverage also
requires supported stage geometry; unavailable measurements remain excluded.
The Pro sample contains **all 27 mapped players in the curated archive**, not
all professionals, and includes only their sides rather than their opponents.
Cohorts overlap, so their game or appearance counts must not be added.

The source population is the existing `nikki-2026-09-08-v10` curation: 142,753
eligible, deduplicated singles games from the audited archive. The sample uses
all 66 retained bundles containing eligible singles, with stable SHA-256 ranking
selecting up to 100 games independently for Venue and Tournament in each bundle.
Pro includes every vetted named-player side in those bundles' conservative games,
without the 100-game cap. Tournament membership is determined
from the **full archive before sampling**, preserving the existing event,
set-sequence, friendly-exclusion, and identity-evidence rules. Existing archive
exports and source selection are not rewritten.

The archive favors recorded events and stream sets. Capped sampling changes
the event mix, and repeated players and character matchups can dominate
opportunities. Rates pool recorded opportunities, not player averages. These
references therefore describe the selected recordings, not skill percentiles
or a general professional average.

The UI sums exact character/opponent/stage cells for the selected Me / Vs /
Stage filters. It never substitutes a broader matchup when the exact sample
is absent. Archive dates span the whole sample; the user's column retains the
current filters and recent-game window. Each cell shows its numerator and
denominator, excludes unresolved outcomes where appropriate, and marks fewer
than 20 qualifying observations as a small sample.

## Reproduction and verification

`scripts/build-nikki-public-archive.mjs --population-index FILE.local.json`
can emit the complete local selection index using the existing v10 build
arguments, without writing public exports. Keep this file outside the repo:
it contains source replay paths. The interaction builder expects this index,
the audited `results-v6` and `downloads`, the frozen source audit, and the v10
named-player evidence export under the archive cache.

```powershell
node scripts/build-interaction-benchmarks.mjs --cache <archive-cache> --per-bundle 100
node scripts/verify-interaction-benchmarks.mjs
node scripts/verify-interaction-benchmark-receipt.mjs --cache <archive-cache> --verify-files true
```

The builder verifies archive counts and sizes, rejects unsafe archive members,
checks staged replay hashes and recorded metadata, and freezes one compiled
parser for the entire run. It fails if detector sources change mid-run. Matching
parser and replay hashes allow interrupted runs to reuse completed parses. A
separate verifier reconstructs cohort selection and aggregates from the local
receipt, checks source fingerprints and every counter partition, and rejects
private or unexpected fields in the published JSON.

Only aggregate counters, public bundle names, provenance hashes, and sample
counts enter `src/data/interaction-benchmarks.json`. Local replay paths, raw
frames, game identities, player identities, and connect codes are excluded.
Lossless counter arrays reduce the shipped JSON to 2,448,378 bytes. The data loads
as a separate chunk and is included in the offline cache; decoding preserves
every counter and the distinction between missing measurements and zero.

The detectors were also checked against personal replays; see the
[defensive audit](defensive-interaction-audit.md) and
[recovery/opening-context audit](recovery-interaction-audit.md). Those audits
inspect action states, inputs, and trajectories. They do not claim independent
human video labels or a measured classifier accuracy rate.
