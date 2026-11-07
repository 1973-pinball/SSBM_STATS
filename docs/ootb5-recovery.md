# Out of the Blue 5: local source recovery

This is a recovery procedure and local validation gate, not a recovery claim.
No original `ootb5` archive has been inspected by this change. Do not publish a
dataset using this procedure until the recovery-aware statistical checks below
pass on the real cache. Pushes, PRs, and publication require
the owner's separate approval.

## Evidence and scope

Checked on 2026-11-07 against GitHub main
`e91b5d0a65c4ce4aaa05127454f8619b2cc83902`. The relevant archive scripts and
runbooks match the local checkout's Git blobs.

| Evidence | What it establishes | What it cannot establish |
| --- | --- | --- |
| [Issue #3](https://github.com/1973-pinball/SSBM_STATS/issues/3), still open with no comments when checked | The cache recovery is outstanding; v10 used 67 bundles and 158,530 unique games; historical `ootb5` expectations are 816,744,003 bytes and 1,545 files | Existence, identity, or integrity of a candidate on the laptop |
| [Archive runbook](https://github.com/1973-pinball/SSBM_STATS/blob/e91b5d0a65c4ce4aaa05127454f8619b2cc83902/ARCHIVE_SPECIAL_MOVES_PLAN.md) | Frozen audit hash, stats6 parser requirements, privacy and measurement rules, published v10 content hash | Original compressed-file checksum |
| [Backfill](https://github.com/1973-pinball/SSBM_STATS/blob/e91b5d0a65c4ce4aaa05127454f8619b2cc83902/scripts/backfill-nikki-archive.mjs) and [builder](https://github.com/1973-pinball/SSBM_STATS/blob/e91b5d0a65c4ce4aaa05127454f8619b2cc83902/scripts/build-nikki-public-archive.mjs) | Backfill selects only non-null `sourceFilename`; source population requires exact source/result membership | Authenticity from a filename alone |
| Local `source-audit-2026-10-22.json` | Its SHA-256 was checked and matches the pinned hash below; v8 has 68 source IDs and an unavailable `ootb5` row | A historical archive SHA: the row has none |
| Local `baseline-v8-bundles.json` and `public-v8-baseline-summary.json` | Historical `ootb5` had 1,545 successful parses, zero failed and zero duplicate copies | Those numbers remaining true under the frozen stats6 parser and a newly curated union |

The normal local downloads directory contained no `ootb5`-named archive when
checked. This was not an exhaustive search of the owner's laptop or backups.
GitHub can establish the code, public history, registries, and issue status.
Only the laptop can supply candidate bytes, download/cache history, original
checksum or replay inventory, actual CRC tests, raw-frame evidence, and a full
reparse. Keep that evidence local.

Preserve these identifiers and artifacts:

- Parent audit SHA-256:
  `8f5a891b991081a3c8dc10e1f01e122ff95f2535f16d59bec1ec5cc86b8db59a`.
- Published `nikki-2026-09-08-v10` content SHA-256:
  `d762c8f1a66b276cf2a7d941ef450bdf5f25e8fc43f67b1811492b9205fce65a`.
- Existing audit, `results-v4/v5/v6`, `backfill-v4/v5/v6`, curation, correction
  evidence and `public-export-v9/v10/v11` remain unchanged.
- [v11 is already published](benchmark-baselines-release.md), with the same 67
  sources and expanded reviewed Pro identities. Do not assume v11 or v12 is free.
  Retain its supplemental identities when preparing the next latest archive.
- [Issue #4](https://github.com/1973-pinball/SSBM_STATS/issues/4) is separate. Do
  not change Bow startup detection, stats version, or any detector for recovery.

The builder does not itself hardcode an `ootb5` exclusion: its default exclusion
list is empty. The v10/v11 runbook commands explicitly pass the exclusion. The
recovery build must omit that argument and use the newly reviewed audit.

## 1. Find and preserve a candidate

Use Node 22, the installed dependencies, Windows `tar` (libarchive), and a
trusted local 7-Zip executable. `tar -tf` alone is not an archive integrity test.
7-Zip was not installed on the machine used to develop this change; install it
through your normal trusted software channel before the real verification.

Run the following from the repository root in PowerShell. Use a new recovery
directory outside Git; reports contain private provenance. Never write into the
old cache's work directories. Reserve at least 66,151,744,566 bytes for copied
compressed inputs, plus result storage and extraction space. The runner can
stage two extracted bundles and retains an additional 8 GiB reserve.

```powershell
$ErrorActionPreference = 'Stop'
function Invoke-LocalNode {
    & node @args
    if ($LASTEXITCODE -ne 0) { throw "Node command failed: $LASTEXITCODE" }
}
$oldCache = Join-Path $env:USERPROFILE '.cache/SSBM_DASHBOARD_nikki_archive'
$recoveryRoot = Join-Path $env:USERPROFILE '.cache/SSBM_DASHBOARD_ootb5_recovery_2026-11-07'
if (Test-Path -LiteralPath $recoveryRoot) { throw 'Choose a fresh recovery directory' }
New-Item -ItemType Directory -Path $recoveryRoot | Out-Null
$oldAudit = Join-Path $oldCache 'source-audit-2026-10-22.json'
$expectedAudit = '8f5a891b991081a3c8dc10e1f01e122ff95f2535f16d59bec1ec5cc86b8db59a'
if ((Get-FileHash -LiteralPath $oldAudit -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedAudit) {
    throw 'Wrong or modified parent audit'
}

# Repeat only for specific cache/backup roots you own. Search by size as well as name.
$searchRoot = Join-Path $oldCache 'downloads'
Get-ChildItem -LiteralPath $searchRoot -File -Recurse |
    Where-Object { $_.Name -match 'ootb|out.of.the.blue' -or $_.Length -eq 816744003 } |
    Select-Object FullName,Length,LastWriteTime
$candidate = Read-Host 'Full path of the preserved original archive candidate'
$sevenZip = Read-Host 'Full path of the trusted 7z.exe'
$technicalReport = Join-Path $recoveryRoot 'ootb5-technical.local.json'
& node scripts/verify-ootb5-recovery.mjs --archive $candidate --audit $oldAudit --seven-zip $sevenZip --report $technicalReport
if ($LASTEXITCODE -ne 2) { throw 'Expected a technical pass awaiting provenance (exit 2); inspect the result' }
```

No candidate is downloaded, renamed, extracted, deleted, or uploaded by the
verifier. On a technical pass without provenance, expect `awaiting-provenance`,
the candidate's freshly computed SHA-256, 816,744,003 bytes, 1,545 replay files,
zero `.slpz` files, and a passed full integrity test. This is **not** an accepted
original. Any failed check exits nonzero and must not produce an accepted report.
Existing reports are never overwritten; use a new filename for a new attempt.
Exit codes are 0 for a technical pass with bound provenance, 2 for a technical
pass awaiting provenance, and 1 for rejection. Exit 2 intentionally stops
unconditional success pipelines while preserving the technical report.

Stop on size/count mismatch, truncation, CRC/test error, missing test utility,
unsafe member paths, links/special files, conflicting Windows names, unsupported
`.slpz`, or a file changing during verification. Do not pad, recompress, rename
members, or adjust expected values to pass. Review any unexpected non-replay
members privately, preserving archive-relative paths because curation uses them.

If only an extracted folder survives, preserve it and make a local per-file
SHA-256 inventory for comparison with an independently preserved old inventory.
It cannot prove the original compressed size or CRC, and repacking it cannot
recreate the original archive. This script deliberately does not accept a
directory or convert a repack into a recovered original. That case requires a
separately reviewed extracted-source audit and ingestion path, or continued
search for the original archive. Issue #3 stays open.

## 2. Review provenance and write a new audit

Size, filename, CRC and count are consistency checks, not proof of origin.
Locate an old download log/checksum, backup manifest, original replay inventory,
or owner cache history that connects the candidate to Out of the Blue 5 and
`https://replays.nikki.sh/`. Compare the real evidence, not merely a label typed
into a JSON file. Review event/date/bracket context without printing private
replay names or connect codes into public reports.

Write `provenance.local.json` outside Git with this schema. Replace every example
value. The tool validates the hash binding and required fields; a human must
authenticate the cited evidence. A checksum computed today must not be called
a historical checksum.

```json
{
  "schemaVersion": 1,
  "bundleStem": "ootb5",
  "archiveSha256": "REPLACE_WITH_CANDIDATE_SHA256",
  "reviewedBy": "REPLACE_WITH_REVIEWER",
  "reviewedAt": "REPLACE_WITH_ISO_TIMESTAMP",
  "basis": "historical-sha256",
  "historicalSha256": "REPLACE_WITH_INDEPENDENT_PREEXISTING_SHA256",
  "evidenceReference": "REPLACE_WITH_LOCAL_EVIDENCE_REFERENCE_AND_ORIGIN_CONTEXT",
  "originalUnmodified": true
}
```

If no pre-existing checksum exists, `basis: "owner-cache-attestation"` is an
explicitly weaker option: omit `historicalSha256`, cite the cache/download
history actually reviewed, and have the owner attest that the original bytes
were preserved. The report distinguishes this from a historical hash match.
The audit revision command rejects that basis unless explicitly passed
`--accept-owner-attestation true`; do not use it merely because the shape fits.
If neither kind of evidence is defensible, reject the identification and keep
the source excluded. No script can manufacture missing historical provenance.

```powershell
$provenance = Join-Path $recoveryRoot 'provenance.local.json'
$verifiedReport = Join-Path $recoveryRoot 'ootb5-verified.local.json'
Invoke-LocalNode scripts/verify-ootb5-recovery.mjs --archive $candidate --audit $oldAudit --seven-zip $sevenZip --provenance $provenance --report $verifiedReport

$newAudit = Join-Path $recoveryRoot 'source-audit-ootb5-recovery-2026-11-07.local.json'
Invoke-LocalNode scripts/revise-ootb5-source-audit.mjs --audit $oldAudit --archive $candidate --verification $verifiedReport --provenance $provenance --revision ootb5-recovery-2026-11-07 --output $newAudit
# For an explicitly reviewed owner attestation, repeat the preceding command
# with --accept-owner-attestation true. Never reuse an already-created output.
```

The revision preserves the entire parent document, including the historical
v8 dataset ID and all 68 source IDs. It changes only `ootb5.sourceFilename`, adds
its `sourceSha256`, and appends revision metadata binding the parent, report,
provenance and assurance level. It does not rewrite historical v8 parse totals
to predict a new result. New outputs use exclusive creation. The full new audit
hash becomes the source-population and receipt binding used by existing tooling.

Expected source totals after this change: **68 bundles, 161,510 replay files,
66,151,744,566 compressed bytes, no excluded bundles**. Do not add a new 69th
`ootb5` row or add Supernova 2026. Successful parses, unique games, duplicate
copies, curation and named-player totals must be recomputed. The historical
160,075 unique-game total is a comparison point, not an acceptance constant.

## 3. Isolate and reparse

Freeze the parser, lockfile, event/series registries and both identity registries
before starting. Record Git commit, dirty patch (if any), tool versions and file
hashes locally. Keep the `ootb5` event/series entries and existing reviewed alias
rules; recovery alone does not justify any alias promotion.

The smallest reliable reuse policy is a full reparse into a new cache. Changing
the audit hash invalidates every old receipt. `--results` alone does not isolate
the runner: its state, lock, extraction and receipts still live in
`<cache>/backfill-v6`. Do not copy/relabel receipts or hand-edit them to avoid a
reparse. A future receipt migration would require a separate proof of equivalent
inputs and is outside this procedure.

```powershell
$downloads = Join-Path $recoveryRoot 'downloads'
New-Item -ItemType Directory -Path $downloads | Out-Null
$revised = Get-Content -LiteralPath $newAudit -Raw | ConvertFrom-Json
foreach ($source in $revised.sources) {
    if (-not $source.sourceFilename) { throw 'Unavailable source remains' }
    $sourcePath = if ($source.id -eq 'nikki-2026-09-08-v8:ootb5') {
        $candidate
    } else {
        Join-Path (Join-Path $oldCache 'downloads') $source.sourceFilename
    }
    $destination = Join-Path $downloads $source.sourceFilename
    if (Test-Path -LiteralPath $destination) { throw 'Refusing to replace a copied original' }
    Copy-Item -LiteralPath $sourcePath -Destination $destination
    if ((Get-Item -LiteralPath $destination).Length -ne $source.compressed_bytes) { throw 'Copied size mismatch' }
    if ((Get-FileHash -LiteralPath $sourcePath).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Copied hash mismatch' }
}
Invoke-LocalNode scripts/backfill-nikki-archive.mjs --cache $recoveryRoot --audit $newAudit --workers 8 --watch false
$state = Get-Content -LiteralPath (Join-Path $recoveryRoot 'backfill-v6/state.json') -Raw | ConvertFrom-Json
if (@($state.completed).Count -ne 68 -or @($state.failures).Count -ne 0 -or @($state.pending).Count -ne 0) {
    throw 'Backfill is incomplete; do not build'
}
$results = Join-Path $recoveryRoot 'results-v6'
$curation = Join-Path $recoveryRoot 'archive-curation-recovery.local.json'
Invoke-LocalNode scripts/curate-nikki-archive.mjs $results $curation
```

The runner's exit status alone is insufficient: missing downloads can leave a
non-watching run incomplete without an orchestration failure. Confirm exact
68-source membership, 68 matching receipts, one frozen parser fingerprint,
replay counts and each `parsed + failed = replayFiles`. Review every new failure
against original bytes; do not silently drop failed records. The new hash checks
bind `ootb5` before/after extraction and parsing, on resume, and at export. Existing
audits without a source hash keep their established behavior.

## 4. Build a local candidate, not a release

First check the published/staged dataset catalog read-only and select an unused
version. Local filesystem absence is not a database uniqueness check. Preserve
`data-as-of 2026-09-08`: restoration is an original-snapshot coverage correction.
Do not repoint forecasts, interactions or live selectors as part of recovery.

```powershell
$version = Read-Host 'Unused version checked against the dataset catalog (vN)'
if ($version -notmatch '^v[1-9][0-9]*$' -or $version -in @('v8','v9','v10','v11')) { throw 'Choose a new unused version' }
$export = Join-Path $recoveryRoot "public-export-$version"
if (Test-Path -LiteralPath $export) { throw 'Export output must be new' }
Invoke-LocalNode scripts/build-nikki-public-archive.mjs --results $results --downloads $downloads --curation $curation --source-audit $newAudit --supplemental-identities scripts/data/interaction-pro-overrides.json --output $export --data-as-of 2026-09-08 --version $version
Invoke-LocalNode scripts/load-public-archive.mjs --dir $export --dry-run
```

Omitting `--exclude-bundles` is deliberate; omitting `--source-audit` is not
allowed by this procedure. The dry run checks local content/counts only and is
not source validation, statistical sign-off, or proof that the ID is unused.
The builder can replace a recognized output directory, so the fresh-output
precondition matters. Never aim this command at a published export.

## 5. Recovery-aware validation

`scripts/verify-archive-recovery.mjs` is a separate local validator for this exact
source restoration. Historical v10/v11 validators retain their original contracts.
The recovery command has no sample profile, no arbitrary population overrides,
no parser-version override, and no network or publication mode. Synthetic tests
inject fixture contracts only through internal module APIs, never CLI flags.

Run after the local build and loader dry run above. Node's larger heap allows
simultaneous independent baseline and recovery rollups while payloads are read
one bundle at a time. The report is created exclusively, outside both exports
and the old cache; choose a new report name on subsequent successful runs.

```powershell
$readiness = Join-Path $recoveryRoot "recovery-$version-readiness.local.json"
Invoke-LocalNode --max-old-space-size=16384 scripts/verify-archive-recovery.mjs --old-cache $oldCache --cache $recoveryRoot --audit $newAudit --verification $verifiedReport --provenance $provenance --dir $export --curation $curation --report $readiness
# Only for the explicitly accepted owner-attestation basis, add:
# --accept-owner-attestation true
```

Success returns exit 0 and `status: "validated-local-candidate"`, the exact
dataset/content hash, reconstructed counts, compared rollups, and offline UI
checks. `publicationAuthorized` remains false. Failure returns nonzero and
does not write a success report. Expected input totals remain 68 / 161,510 /
66,151,744,566; actual parse, unique-game, duplicate, curation and Pro totals
come from the records. This command does not prove the chosen ID is unused in
the live catalog or replace raw-replay investigation of new failures.

The gate binds the preserved v11 content fingerprint and the frozen stats6
parser fingerprint `cc6083652ac2bf22c3ac0eb7e2219e28215bb5721858c433963c19181751951e`.
If a checkout has different parser bytes (including line endings), stop and
establish the frozen implementation before parsing. Do not edit receipts or
replace the expected fingerprint to pass. Bow handling and all prior unknown
measurements remain unchanged.

The reference implementation does not invoke the builder or curator to obtain
expected values, and does not use their aggregation or identity-resolution
helpers. It reconstructs both the preserved v11 and candidate exports from
local records and reviewed registries, compares every public table, and then
reconciles the source-addition effects. Production query/display code is used
only for offline UI checks, against these independently reconstructed values.

| Historical check | Recovery replacement |
| --- | --- |
| `verify-archive-special-export.mjs` fixes v10/67 sources and legacy Pro identities | The boundary module verifies exact parent/new audit lineage, all 68 IDs, receipts and unchanged old payloads. The population/export modules independently reconstruct reviewed legacy + supplemental identities, curation, every public row and all rollup dimensions. |
| Full-only positive coverage checks | The recovery rollup reference requires all 26 singles characters × four directions in both community populations, supported outcomes for samples of at least 25 sides, and named/pooled Pro coverage with explicit sparse-unavailable reporting. |
| Historical completeness corrections and specials baseline | Historical evidence stays intact. Recovery allows only top-level `analyzedAt` to differ in the old 67 payloads; every record, error, identity and measurement must match. The old and new receipt/output hashes remain separate. `ootb5` has no v4 correction baseline. |
| Identity-only v10→v11 Pro verifier | Recovery reconstructs both v11 and the new union, preserving reviewed mappings, slot/character checks and evidence. A hashed identity ledger records every representative, curation, set or public-side change caused by adding the source. |
| Historical special-move spot check | The recovery selector module checks actual production query/display functions offline against independent pooled Pro expectations, including all-character, opponent, stage and named-player selections. It never substitutes summed sparse per-player rows for pooled Pro. |

The implemented gate performs the following checks:

1. Bind receipts to the new audit, frozen parser and output hashes; bind the old
   67 inputs to their preserved receipts. The revised audit must differ from its
   pinned parent only as described above. Prove every original result record was
   retained and the recovered archive still matches its audited SHA-256.
2. Independently rerun the existing identity-key deduplication over all 68
   sources, retaining the existing deterministic representative policy. Require
   `parsed + failed = 161510` and `parsed - duplicateCopies = uniqueGames`.
   If the recovered source has `p` parsed and `f` failed files, require
   `p + f = 1545`, `parsed = 158884 + p`, `failed = 1081 + f`, and
   `uniqueGames - 158530 = p - (duplicateCopies - 354)` after proving the old
   67 payloads unchanged.
   Reject `p = 0`: an entirely failed recovered source cannot borrow positive
   coverage from the original 67 bundles. Nonzero recovered failures remain
   explicit and require evidence review; historical v8 success totals are not
   silently forced onto a stats6 parse.
   Inventory duplicate groups involving `ootb5`; explain any representative,
   event classification or public identity change. Do not assume +1,545 unique
   games or simply add `ootb5` rollups to v10/v11.
3. Reconstruct technical exclusions, venue/broad and conservative tournament
   membership, set inference, named sides, and every global, character, opponent,
   stage, event, series, player and Pro rollup with existing sparse thresholds
   and player-balanced denominators. Compare every field, including non-special
   metrics. Reconcile the new union against the unchanged 67-source control and
   the documented dedup effects; population changes do not justify metric drift
   in unchanged records. Account for rows crossing publication thresholds.
4. Preserve parser finalized-frame, rollback and completeness safeguards by
   requiring the exact frozen parser and unchanged old records, including all
   previously proven withdrawals and issue #4 unknown sides. Raw-frame accuracy
   is not established by a derived-statistics comparison: the owner must still
   review new `ootb5` failures or unexplained gaps against original replay hashes
   and bounded/retained or raw-frame evidence before publication.
5. Validate moves 18/19/20/21 independently: attempts require explicit measured
   fields; outcome counts require the complete hit/no-hit/incomplete partition;
   outcome-tracked sides are a subset of attempt-tracked sides. Attempts/game
   uses attemptGames, no-hit uses/game uses outcomeGames, and no-hit rate uses
   hit+noHit (excluding incomplete). Unsupported outcomes remain unavailable,
   not zero; no-hit includes shield/defensive uses and is not an exact whiff.
6. Audit all public NDJSON for private paths/replay filenames, connect codes,
   private user IDs/hashes, unresolved tags and unapproved aliases. Public named
   rows remain eligible conservative games with approved identity evidence;
   anonymous replays contribute only to aggregates. Keep candidate identity
   reports, source filenames, provenance and raw bytes off public storage.
7. Independently recompute export content hash and table counts, and produce a
   separate immutable readiness report binding all input,
   registry, parser, audit, output and verification hashes. This report is the
   concrete object for the owner's publication approval, together with the
   separate loader dry run from step 4 and any required raw-evidence review.

Focused synthetic fixtures reject a missing old bundle, an unexpected
69th bundle, a duplicate source row, a same-size archive substitution, forged
receipt, altered old metric, changed old unknown denominator, unapproved alias,
wrong pooled-Pro count and an unavailable cohort. Positive fixtures include a
cross-source duplicate whose representative changes and a sparse rollup crossing
its threshold. Tests exercise real builder outputs and reseal deliberately
tampered exports so independent statistical checks, rather than only the content
hash, have to detect the error.

## Checks available now

These run without the missing original and do not publish anything:

```powershell
Invoke-LocalNode --test 'scripts/recovery-tests/*.test.mjs'
Invoke-LocalNode scripts/verify-archive-source-population.mjs
Invoke-LocalNode scripts/verify-archive-move-coverage.mjs
Invoke-LocalNode scripts/verify-archive-pro-identity.mjs
Invoke-LocalNode scripts/verify-archive-load-preflight.mjs
```

Before a real rebuild also run `npm run verify:moves`, relevant parser/rollback
regressions, and the current identity/privacy release checks. The old full-cache
validators remain useful for proving the preserved historical exports still
pass with their original inputs. Their expected counts are not recovery values.
The recovery test suite is also available as `npm run verify:recovery`.

On 2026-11-07, a read-only reconstruction of the preserved v11 cache passed with
159,965 files, 158,884 parsed files, 1,081 failures, 354 duplicate copies and
158,530 unique games. All 51,385 rollups and public rows matched independently;
98 players remained mapped. The offline production selectors passed 59,952
metric checks. This validates the reference against existing evidence; it does
not establish `ootb5` recovery. No report or other file was written into the
preserved cache during that check.

## Proceed / hold / reject

- **Proceed to a local reparse:** technical verification passes, provenance is
  defensible and explicitly recorded, new audit has the exact one-source delta,
  copies hash-match, and the old cache is untouched.
- **Hold:** no original candidate, only extracted files, no trustworthy origin
  evidence, missing 7-Zip, inadequate disk, parser/receipt drift, unexplained
  failures/duplicates, or recovery-aware statistical verification failing.
- **Reject this candidate:** wrong size/count, corrupt archive, unsafe members,
  mismatched historical checksum, changed bytes, conflicting provenance, or a
  repack presented as the original. Preserve evidence for investigation.
- **Proceed to publication only after separate approval:** all recovery checks
  pass, an unused immutable dataset ID is verified, a concrete readiness report
  is reviewed, and the owner approves the specific export/content hash. Only
  then use the existing staged/atomic loader flow. Recheck live Move Atlas and
  Execution against approved spot-check values, preserving v10/v11. Remove the
  exclusion note and close issue #3 only after confirmed inclusion. Do not push,
  create a PR, publish, update issue comments or change production during local
  verification. Issue #4 remains separate.
