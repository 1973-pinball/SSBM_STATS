# Continue forecast work on another computer

The Git repository contains forecast code, tests, reviewed mappings, the corpus
contract, documentation, and the reviewed website derivative. It deliberately
does **not** contain the Start.gg token or `.forecast/` research workspace.
A clone is enough to build the current website; it is not enough to reproduce
the exact local research state.

## Build and view the committed website

Prerequisites: Git, Node.js 22, and npm.

~~~sh
git clone https://github.com/1973-pinball/SSBM_STATS.git
cd SSBM_STATS
npm ci
npm run test:forecast
npm run build
~~~

Use `npm run dev` and open the Tournaments view. The bundled prediction page
does not need a Start.gg credential, `.forecast/`, or Supabase.

## Choose a research transfer

As of dataset `e21eb6bf…`, the measured retained local workspace is
2,813,648,522 bytes (about 2.62 GiB). It contains retained generations,
checkpointed tuning work, and reports, not one required file. The model-ready
canonical dataset itself is still 379,603,382 bytes.

| Transfer | Approximate size | Supports |
|---|---:|---|
| Model-ready generation | 380 MB | Verify/use the canonical dataset and rerun evaluation |
| Source-auditable evidence | 1.13 GB | Recheck the selected raw bundles and request receipts as well as the dataset |
| Full continuation snapshot | 2.62 GiB | Preserve old generations, tuning checkpoints, reports, Riptide state, and all local history |

The source-auditable tier does not yet have a one-command packer. Until it does,
use the full snapshot when exact source replay matters. Do not guess a subset of
cache files: source-readiness validates every referenced receipt.

Ordinary GitHub blobs cannot hold the 379.6 MB canonical JSON. Git LFS would
store each regenerated monolith as another large object, so it is not the
default. Use a private object store, private file transfer, or external drive.
Do not publish raw Start.gg responses without a separate redistribution review.

## Transfer the model-ready generation

Stop all forecast commands first. Write the archive outside the repository so
it cannot become an accidental untracked project file:

~~~sh
tar -czf /path/outside/repo/ssbm-forecast-e21eb6bf-model.tgz \
  .forecast/latest.json \
  .forecast/datasets/e21eb6bf8d91b295b875ab11959e1beddae937d7816e5c7da1a2f13db3f6371d
shasum -a 256 /path/outside/repo/ssbm-forecast-e21eb6bf-model.tgz
git rev-parse HEAD
git status --short
~~~

Record the archive SHA-256 and producing Git commit beside the transferred
file. The working tree currently must also be committed/pushed or transferred
separately; an archive cannot make uncommitted code reproducible.

On the destination, check out that exact commit, verify the archive checksum,
and extract only into a fresh research directory:

~~~sh
shasum -a 256 /path/to/ssbm-forecast-e21eb6bf-model.tgz
test ! -e .forecast
tar -xzf /path/to/ssbm-forecast-e21eb6bf-model.tgz
npm run forecast -- status
npm run forecast -- evaluate
npm run forecast -- storage
~~~

Do not merge an exact snapshot into a stale `.forecast/`; rename the old
directory first if it must be retained.

## Transfer nested tuning results or checkpoints

An exact completed tuning result requires the content-addressed run artifacts
plus the mode-specific latest pointers:

- `.forecast/tuning/runs/`
- `.forecast/latest-tuning-strict-seeds.json`
- `.forecast/latest-tuning-availability-assumed.json`

`.forecast/latest-tuning.json` is only a convenience pointer to the last mode
that completed; do not use it alone to identify both runs. If tuning must resume
on the destination without recomputing completed event folds, also transfer
`.forecast/tuning/event-forecasts/` and `.forecast/tuning/resume/`.

For the smallest exact-results transfer, archive the run directory and the two
mode-specific pointers. For a resumable transfer, include all five paths named
above.
The full continuation snapshot already includes them.

## Transfer the full continuation snapshot

With no forecast command running:

~~~sh
tar -czf /path/outside/repo/ssbm-forecast-full.tgz .forecast
shasum -a 256 /path/outside/repo/ssbm-forecast-full.tgz
git rev-parse HEAD
git status --short
~~~

Transfer the archive privately, verify its checksum on the destination, require
that `.forecast/` does not already exist, then extract from the repository root.
Delete the transfer archive after verification if it is no longer needed.

## Recreate the credential separately

Never put `.env.forecast.local` in an archive or repository. Create it directly
on the destination:

~~~dotenv
STARTGG_TOKEN=your-token-here
~~~

On macOS or Linux, run `chmod 600 .env.forecast.local`. If the old computer is
no longer trusted, revoke its token and issue a new one.

## Rebuild instead of transferring

The tracked mappings and pipeline can construct a new workspace:

~~~sh
npm run forecast -- registry
npm run forecast -- download --all-mapped
npm run forecast -- normalize --strict-corpus
npm run forecast -- corpus --strict-corpus
npm run forecast -- evaluate
npm run forecast -- tune
# Sensitivity analysis only: assumes historical seeds were available pre-event.
npm run forecast -- tune --allow-unverified-historical-seeds
npm run forecast -- storage
npm run forecast:riptide
npm run predictions:build
~~~

This requires a Start.gg token and network access. It may not reproduce existing
hashes because Start.gg can correct historical responses. Transfer `.forecast/`
when exact observations matter.

## What remains machine-local

- `.forecast/`: source responses, canonical datasets, evaluations, tuning runs
  and checkpoints, reports, caches, and upcoming-event snapshots.
- `.env.forecast.local`: the Start.gg credential.
- Uncommitted working-tree files. Commit the intended work or transfer that
  working tree before retiring the source computer.

Raw `.slp` replay files remain local under the product privacy contract and are
unrelated to this public tournament forecast dataset.
