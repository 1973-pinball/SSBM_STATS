# Continue forecast work on another computer

Git contains the forecast code, reviewed event mappings, tests, and website
predictions. The ignored `.forecast/` workspace contains historical observations,
evaluation artifacts, and fitted model weights. A clone builds the saved website;
use the backup below to reproduce a forecast or reuse its fitted model.

## Build the saved website

Prerequisites: Git, Node.js 22, and npm. Backup commands also need `tar`, included
with current Windows, macOS, and typical Linux installations.

```sh
git clone https://github.com/1973-pinball/SSBM_STATS.git
cd SSBM_STATS
npm ci
npm run test:forecast
npm run build
npm run dev
```

Open `/?view=tournaments`. The bundled Tournament Predictions page needs no
Start.gg credential, research workspace, or Supabase connection.

## Make a portable forecast backup

Stop commands that write the dataset, evaluation, or fit before packaging.
Read `.forecast/latest-upcoming.json` for the exact `file` path, then pass it
explicitly:

```sh
node scripts/package-forecast.mjs --bundle .forecast/public-raw/<bundle-sha256>.json
```

The default output is `.forecast/backups/forecast-<dataset-prefix>-<timestamp>.tgz`
plus a `.tgz.sha256` checksum file. `--root DIR` selects another research workspace;
`--output FILE.tgz` selects an archive destination. The command prints the archive
checksum, producing Git commit, and whether the working tree was dirty. Commit
intended code changes before creating a release backup so the recorded commit
alone identifies its implementation.

The packer verifies dataset and fitted-model hashes, recomputes the evaluation
run hash, and checks that the fitted model matches the selected event snapshot.
It includes only:

- `latest.json` and the referenced dataset generation's recognized JSON files.
- `latest-evaluation.json` and its comparison, predictions, and calibration files,
  when present.
- `latest-model.json` and its content-addressed fitted model, when present.
- The explicitly selected sanitized `public-raw/<sha256>.json` upcoming bundle.
- `backup-manifest.json`, recording each file's SHA-256 and size, the Git commit,
  dataset identity, and upcoming bundle path.

Archive paths start with `.forecast/`, even when `--root` points to a differently
named directory. Source-response caches, unrelated raw bundles, credentials,
environment files, Slippi replays, and tuning checkpoints are excluded. This is
a model-ready backup; it does not retain every original request receipt needed
to repeat a source-level audit. Keep those receipts separately when required.

The generated archive and checksum file can be attached to the corresponding
GitHub release. The packer itself performs no upload.

## Restore and reproduce

Check out the commit recorded in the backup manifest. Before extraction, compare
the downloaded archive's checksum with its companion file:

```powershell
Get-FileHash -Algorithm SHA256 .\forecast-backup.tgz
```

On macOS/Linux use `shasum -a 256 forecast-backup.tgz`. Inspect entries with
`tar -tzf forecast-backup.tgz`, then extract into a fresh directory:

```sh
mkdir restored-forecast
tar -xzf forecast-backup.tgz -C restored-forecast
node scripts/package-forecast.mjs --verify --root restored-forecast/.forecast
```

Verification checks every recorded file's bytes and hash, then rechecks the
dataset, evaluation, fitted model, and sanitized upcoming bundle pointers. It
does not fit models or contact a service. Preserve an existing research workspace
separately instead of extracting over it.

The verification output includes `upcomingBundle`. Use that exact relative path
under `restored-forecast` to regenerate all six models and the site catalog:

```sh
node scripts/build-site-predictions.mjs --root restored-forecast/.forecast --bundle restored-forecast/.forecast/public-raw/<bundle-sha256>.json --event 1661592
npm run build
```

This fits the six-model suite from the saved training corpus. It preserves prior
catalog tournaments and puts the requested event first, making it the dropdown
default on a fresh page load. Platfight's route is conditional on the displayed
top 16 seeds surviving earlier rounds; its probabilities are conditional set
estimates, not title odds or a full-field simulation.

## Reuse the fitted model without training data

`build-site-predictions.mjs` also saves the default regularized Bradley–Terry fit
in `models/<sha256>.json` and points `latest-model.json` to it. The snapshot
contains player abilities, fitted coefficients, feature scales, and recent-form
state. `restoreRegularizedBradleyTerryModel` restores this fit without reading
historical sets. The other five models still require their training corpus.

For a small inference-only transfer, retain `latest-model.json`, its referenced
model file, `backup-manifest.json`, and the upcoming bundle named there. This
subset can run the example below; full-backup verification expects the complete
archive. Place these files under `.forecast/` at the repository root before
running the example.

Save the following as `.forecast/predict-saved.mjs`, then run
`node .forecast/predict-saved.mjs` from the repository root:

```js
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { restoreRegularizedBradleyTerryModel } from "../scripts/lib/forecast/regularized-bradley-terry.mjs";
import { selectRootFullFieldSeedPhase } from "../scripts/lib/forecast/upcoming-report.mjs";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const pointer = await json(".forecast/latest-model.json");
const body = await readFile(".forecast/" + pointer.model, "utf8");
if (sha256(body) !== pointer.sha256) throw new Error("Model checksum mismatch");
const backup = await json(".forecast/backup-manifest.json");
const bundleBody = await readFile(backup.upcomingBundle, "utf8");
const bundleEntry = backup.files.find((file) => file.path === backup.upcomingBundle);
if (sha256(bundleBody) !== bundleEntry?.sha256) throw new Error("Bundle checksum mismatch");
const bundle = JSON.parse(bundleBody);
const root = selectRootFullFieldSeedPhase(bundle);
const seedIndex = { seeds: new Map(root.seeds.map((seed) =>
  ["startgg:entrant:" + seed.entrantId, seed.seedNum])) };
const model = restoreRegularizedBradleyTerryModel(JSON.parse(body).snapshot, { seedIndex });
const pair = root.seeds.slice(0, 2).map((seed) => {
  const entrant = bundle.entrants.find((row) => String(row.id) === seed.entrantId);
  return { entrantId: "startgg:entrant:" + seed.entrantId,
    playerId: "startgg:player:" + entrant.participants[0].player.id };
});
console.log(model.predict({ entrantIds: pair.map((row) => row.entrantId),
  playerIds: pair.map((row) => row.playerId) }));
```

The example predicts a set between the first two current seeds. Its abilities and
recent form remain **frozen at the saved cutoff**. Supplying new seeds does not
advance the form date or incorporate later results. Refit when those inputs need
updating, and record the resulting cutoff with the new backup.

## Rebuild public inputs when no backup exists

The public reconstruction flow needs no Start.gg token:

```sh
node scripts/restore-public-forecast.mjs --census
node scripts/restore-public-forecast.mjs
npm run forecast -- evaluate
node scripts/restore-public-forecast.mjs --upcoming 1661592
```

The historical downloader resumes from verified local observations and publishes
`latest.json` only after the complete reviewed cohort passes membership checks.
`--event ID` warms one reviewed historical event's cache; it does not publish a
reduced training dataset. `--upcoming ID` fetches a new upcoming snapshot and
writes `latest-upcoming.json`. Read its `file`, run the site builder with
`--bundle` and `--event`, then create a backup.

These observations are explicitly labeled `startgg-public-legacy-v1`. The adapter
reconciles event/group collections and retains stable public player identities,
but the legacy service supplies no independent pagination totals. Ladder groups
that omit legacy sets use the public website's anonymous GraphQL endpoint with
separate `startgg-public-web-graphql-v1` receipts and verified pagination totals.
Public reconstruction does not claim the original GraphQL receipt audit, and a later
download can produce different hashes if the source changed. Historical seed
availability remains an assumption, not proof that a seed was known before its
event.

The reconstruction preserves the existing outcome eligibility rules. Missing or
invalid scores remain excluded even when the source reports a winner, so some
events have sparse eligible coverage. Eligible sets from all phases within each
reviewed event are retained, including amateur or exhibition phases where present;
this dataset is not restricted to the main bracket.

The existing authenticated `npm run forecast -- download --all-mapped` workflow
remains available for GraphQL research. Its credential belongs only in the ignored
`.env.forecast.local` file or the process environment. Create or transfer that
credential separately; never add it to a forecast archive.

Nested tuning checkpoints, old generations, and raw response receipts remain
machine-local unless separately transferred. Raw `.slp` files are unrelated to
this public tournament forecasting workflow.
