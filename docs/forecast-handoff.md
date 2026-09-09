# Continue forecast work on another computer

The Git repository contains the forecast code, tests, reviewed event mappings,
documentation, and the generated website catalog. It deliberately does **not**
contain the Start.gg token or the ignored `.forecast/` research workspace.

## Build and view the current website forecast

This path does not need `.forecast/` because the reviewed Riptide derivative is
already tracked in `src/lib/tournamentPredictionData.ts`.

Prerequisites: Git, Node.js 22, and npm.

~~~sh
git clone https://github.com/1973-pinball/SSBM_STATS.git
cd SSBM_STATS
npm ci
npm run test:forecast
npm run build
~~~

Use `npm run dev` for a local development server, then open the Tournaments
view. The prediction page does not need a Start.gg credential or Supabase.

## Continue from the exact research snapshot

The current `.forecast/` directory is roughly 290 MB. It contains the immutable
observed Start.gg responses, normalized canonical dataset, evaluations, and
reports that produced the tracked website catalog. Transfer it separately if
the exact hashes and historical observations matter.

On the source computer, while no forecast command is running:

~~~sh
npm run forecast -- status
tar -czf ssbm-forecast-state.tgz .forecast
~~~

Copy `ssbm-forecast-state.tgz` to the destination using a private transfer
method or external drive. Do not add it to Git. From the repository root on the
destination computer:

~~~sh
tar -xzf /path/to/ssbm-forecast-state.tgz
npm run forecast -- status
npm run predictions:build
git diff --exit-code -- src/lib/tournamentPredictionData.ts
~~~

The final command should show no difference when the transferred research state
matches the committed catalog. Delete the transfer archive after verifying the
copy if it is no longer needed.

Do **not** put `.env.forecast.local` in the archive or repository. Create it
directly on the destination with a Start.gg developer token:

~~~dotenv
STARTGG_TOKEN=your-token-here
~~~

On macOS or Linux, restrict that file to the current user with
`chmod 600 .env.forecast.local`. If the old computer is no longer trusted,
revoke its token and issue a new one.

## Rebuild instead of transferring

The tracked mappings and pipeline can reconstruct a new research workspace:

~~~sh
npm run forecast -- registry
npm run forecast -- download --all-mapped
npm run forecast -- normalize
npm run forecast -- evaluate
npm run forecast:riptide
npm run forecast -- storage
npm run predictions:build
~~~

This requires the local token and network access. It is not guaranteed to
reproduce the existing hashes because Start.gg can correct or replace historical
responses. Transfer `.forecast/` when exact reproducibility matters.

## What remains machine-local

- `.forecast/`: source responses, canonical datasets, reports, and caches.
- `.env.forecast.local`: the Start.gg credential.
- Uncommitted files in a working tree. Commit the intended work or transfer that
  working tree separately before retiring the source computer.

Never commit either `.forecast/` or `.env.forecast.local`. Raw `.slp` replay
files remain local under the product privacy contract and are unrelated to the
public tournament forecast dataset.
