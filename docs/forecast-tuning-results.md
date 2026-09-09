# Six-model out-of-sample tuning results

> Updated 2026-09-09. These are retrospective, chronology-isolated diagnostics,
> not a production model selection. No forecast data was uploaded.

## Result in one sentence

Tune Elo to **K=64 with a 730-day half-life**, Glicko-2 to **initial RD=500**,
and dynamic Bradley–Terry to **a 730-day half-life with ridge=1** for further
research. Keep regularized Bradley–Terry on its frozen defaults until its
optimizer is made more reliable and retested. Historical seeds make the
regularized model much stronger, but they do not make its hyperparameter-tuning
gain reliable.

## What was tested

The frozen grid contains 24 configurations across the six model families:

- neutral and higher-seed baselines: one fixed configuration each;
- recency Elo: K in 16/32/64 and half-life in 365/730 days;
- Glicko-2: initial RD in 200/350/500;
- dynamic Bradley–Terry: half-life in 180/365/730 days and ridge in 1/2; and
- regularized Bradley–Terry + seed + recent form: the default plus six
  one-at-a-time changes to ability penalty, feature penalty, or form half-life.

Every outer fold holds out a whole later event. Hyperparameters are chosen only
from completed earlier inner event folds, after a 16-event warm-up (at least five
training events and 12 completed inner validation events). Selection minimizes
event-macro log loss, then applies a paired one-standard-error rule that prefers
the default-nearest configuration; Brier score and configuration ID are the
remaining tie-breakers. Accuracy and AUC are reporting metrics, not objectives.

The run scored 83 outer events and 74,891 held-out sets. Each candidate forecast
was durably checkpointed before its target outcomes were accessed. Tests verify
that changing a target outcome cannot change its own or any earlier forecast,
overlapping events are excluded, input order is irrelevant, and post-event end
metadata cannot change forecast identity.

## Strict-seed result

Strict mode admits a seed only when its observation is proven to precede the
event cutoff. None of the 58,318 historical seeds has that proof, so higher seed
correctly reduces to neutral. The other models remain useful for evaluating
history-only prediction.

| Model | Event-macro log loss ↓ | Brier ↓ | Accuracy | AUC |
|---|---:|---:|---:|---:|
| Glicko-2 | **0.5525** | **0.1876** | **70.29%** | **0.7881** |
| Regularized BT + recent form | 0.5629 | 0.1903 | 69.05% | 0.7700 |
| Recency Elo | 0.5823 | 0.1972 | 69.93% | 0.7793 |
| Dynamic Bradley–Terry | 0.5936 | 0.2051 | 64.86% | 0.7267 |
| Neutral / higher seed | 0.6931 | 0.2500 | 50.00% | 0.5000 |

Tuned minus frozen-default differences are below. Negative is better; intervals
are descriptive paired event-cluster bootstrap 95% intervals.

| Family | Mature folds | Δ log loss [95%] | Δ Brier [95%] | Selected setting |
|---|---:|---:|---:|---|
| Recency Elo | 67 | **−0.02061 [−0.02814, −0.01136]** | **−0.01009 [−0.01184, −0.00820]** | K=64, 730 days in 67/67 |
| Glicko-2 | 67 | **−0.00526 [−0.00787, −0.00283]** | **−0.00134 [−0.00210, −0.00057]** | initial RD=500 in 67/67 |
| Dynamic BT | 67 | **−0.01384 [−0.01780, −0.00921]** | **−0.00599 [−0.00721, −0.00473]** | 730 days, ridge=1 in 66/67 |
| Regularized BT | 30 | −0.01401 [−0.02963, +0.00131] | −0.00681 [−0.01327, −0.00025] | ability L2=1 in 30/30 |

Elo, Glicko-2, and dynamic BT improve on both proper scoring rules with intervals
entirely below zero. Regularized BT's primary log-loss interval crosses zero;
37 mature folds had no fully valid inner candidate history and six outer fits
used an explicitly scored neutral fallback. Its apparent tuning gain is not
stable enough to adopt.

## Historical-seed sensitivity

The separate sensitivity assumes that the fetched initial seed values were
available before each historical event. That is plausible, but unverified; it
must not be merged into the strict result or described as snapshot-safe.

| Model | Event-macro log loss ↓ | Brier ↓ | Accuracy | AUC |
|---|---:|---:|---:|---:|
| Regularized BT + seed + form | **0.5085** | **0.1689** | 74.63% | **0.8202** |
| Higher seed | 0.5503 | 0.1824 | **74.87%** | 0.7479 |
| Glicko-2 | 0.5525 | 0.1876 | 70.29% | 0.7881 |
| Recency Elo | 0.5823 | 0.1972 | 69.93% | 0.7793 |
| Dynamic Bradley–Terry | 0.5936 | 0.2051 | 64.86% | 0.7267 |
| Neutral | 0.6931 | 0.2500 | 50.00% | 0.5000 |

The regularized model's tuned-policy-versus-default differences are only
−0.00480 log loss (95% interval −0.02292 to +0.01229) and −0.00177 Brier
(−0.00942 to +0.00569). Both intervals cross zero. Of 52 mature selected folds,
27 chose ability L2=1, 20 chose a 365-day form half-life, and five retained the
default; 15 other mature folds lacked a fully valid inner history and four outer
fits used neutral fallback. The large absolute improvement over strict mode is
therefore evidence about **seed availability**, not reliable evidence that the
regularized model's hyperparameters were improved.

## Decision

- Adopt the three stable tuned settings as research defaults for their own
  families, subject to a fresh prospective check.
- Retain the regularized model's frozen defaults and repair its convergence
  behavior before widening or rerunning its grid.
- Do not select a model family or publish title odds from these results. Glicko-2
  is the strongest stable history-only model by event-macro proper scores;
  regularized BT + seed + form is the strongest seed-assumed model by those
  scores. That comparison is descriptive and depends on unverified seed history.
- Keep the retrospective, non-snapshot-verified label on these results. The
  owner accepts that limitation for the current release; immutable pre-event
  snapshots are optional follow-on evidence rather than a blocker.

## Reproducibility

Run the strict default and the explicitly labeled sensitivity separately:

~~~sh
npm run forecast -- tune
npm run forecast -- tune --allow-unverified-historical-seeds
~~~

Strict run: `194fcc586f1e95a984fa0f1e5e54abe01143d11b21bb599a0b4e3aa6a0a135d4`;
forecast `018cd3121e25fd25f09c769d9777b5ce57127d0bad6ba5d42a3e1dbda6665d7d`;
evaluation `e2677ffcc64d14217d237ea67d494141670b448da1ab476347550ce298f6cfd1`;
report `ff9c02dcb7e0f5984549da28f893d9543cabf007b9a8713e563cd58282a8738b`.

Seed-assumed run: `3f6d9ef3b13becea3501df2afab2783bc94f42412d6edd05948563afb4a31115`;
forecast `73ded4c5d62bbbe94619c3e4c774aba8dada3276b89ac37f8b5219c378398a5d`;
evaluation `4443594ae5be8d9269a5bc3758af28ffcb1af004200bdf2ec77168ede5a5d606`;
report `9578b87d0a8a73925231e52310f7b21fb74a086d6d81375ed0a732db0e4c2e5a`.

Both runs use canonical dataset
`e21eb6bf8d91b295b875ab11959e1beddae937d7816e5c7da1a2f13db3f6371d`,
semantic dataset digest
`19bdbde0b9755925c81ad40d64a4567fd1f35310b6034cc2a53bda5cc082b81b`,
and frozen tuning-spec semantic digest
`30d52b2a2471c2db0aa2e3bda56e7098f2d7e7807f570c27af3f3c208311ce6a`.

All observations were fetched on 2026-09-09, after the 2018–2025 events. The
implementation prevents target-outcome look-forward within the dataset, but it
cannot prove that later Start.gg corrections were absent from those observations.
