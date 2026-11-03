# Repository automation

## Liquipedia updates

`liquipedia-refresh.yml` runs weekly or manually on `main`. It generates the
snapshot from current `main`, builds it, and creates or updates one pull request
from `automation/liquipedia-snapshot`. Only `src/lib/liquipedia/data.ts` is
committed. A failed build publishes nothing; an unchanged or rate-limited fetch
leaves any existing update PR alone. The bot never merges or pushes to `main`.

The repository's **Settings → Actions → General → Allow GitHub Actions to create
and approve pull requests** setting must be enabled. Default workflow token
permissions remain read-only; this workflow explicitly requests contents and
pull-request write access. It uses the temporary `GITHUB_TOKEN`, with no stored
personal token and no branch-protection bypass.

GitHub may show **Approve workflows to run** on bot-created or updated PRs.
A maintainer must approve those runs, then wait for the normal `build` and
`Vercel` checks. A manually dispatched CI run is not a substitute for a required
PR check. See [GitHub's event rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
and [required-check restrictions](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

If `main` advances, update the PR branch and wait for its checks again before
merging. Vercel deploys production after the PR is merged into `main`.

## Main branch protections

`rulesets/main.json` records the GitHub API configuration for the active
**Protect main** branch ruleset. Committing this file does not apply it; the
repository administrator applies it through GitHub's rulesets API or settings.

The rule blocks deletion and force pushes, requires a PR with all review
conversations resolved, and requires an up-to-date branch with successful
`build` (GitHub Actions, app 15368) and `Vercel` (app 8329) checks. Required
approvals are zero for a single-maintainer repository. There are no bypass
actors, including administrators and automation.
