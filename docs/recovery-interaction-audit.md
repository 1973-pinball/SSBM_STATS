# Recovery, edgeguard and opening-context audit

Reviewed on 2026-11-02 for the experimental interaction metrics in v0.4.9.

This review used actual local replay frame states and trajectories. It did **not**
watch rendered Melee video, establish player intent, or measure classifier accuracy.
The review found and corrected several concrete classification errors. The
remaining metrics are descriptive estimates with explicit coverage limits.

## Sample and method

The audit selected 32 singles games from a local library of 3,001 replay files.
It sampled across sorted library positions and preferred distinct stage/character
combinations. The sample covers all six legal stage IDs and 15 characters, but
27 of the games contain Marth. It is neither a random tournament sample nor a
representative estimate of the whole roster.

The reusable script is `scripts/audit-recovery-replays.mjs`:

```sh
node --experimental-strip-types scripts/audit-recovery-replays.mjs <local-replay-directory> 32 --details
```

An optional `--probe=sample:player-slot:first-frame:last-frame` prints the detector
state beside a selected frame interval. The script emits sample numbers, player
slots, state IDs, coordinates and aggregate counts. It never emits replay file
names, account names or connect codes. Raw replay files remain local.

The script captures production episode boundaries, then separately scans raw
positions, percent changes, capture transitions, ledge states and stock changes.
Its candidate search deliberately uses broader boundaries and a 90-frame prior
damage lookback to surface omissions. Those candidates are **not ground truth**.
Selected positive classifications and unmatched candidates were inspected as
action/position traces, including deliberate excursions, slide-offs, direct
launches, ledge catches, returns, deaths, grabs and combo followups. This goes
beyond the earlier bounded-versus-retained parser equality test.

## Final counts

| Measure | Count |
| --- | ---: |
| Singles games inspected | 32 |
| Frame entries inspected, including countdown | 362,615 |
| Frame entries from frame 0 onward | 358,679 |
| Games with recovery/edgeguard coverage | 25 |
| Stadium games without explicit frozen-stage coverage | 7 |
| Recorded recovery attempts | 399 |
| Completed recovery episodes | 396 |
| Incomplete recovery episodes | 3 |
| Unpublished launch-only episodes without an observed recovery opportunity | 44 |
| Broad offstage candidates | 933 |
| Candidates near prior damage | 643 |
| Candidates without recent damage under the broad search | 290 |
| Unmatched candidates near prior damage requiring interpretation | 26 |
| Opening contexts recorded | 1,728 |
| Candidate percent-increase/capture events | 2,738 |
| Subsequent events grouped into an existing opening | 996 |
| Non-reactive damage candidates excluded as opening starts | 14 |
| Checked aggregate outcome identities | 284 |

The 26 unmatched recovery candidates mostly contain shallow landing-root dips or
deliberate excursions after grounded control. Marginal airborne boundary cases
remain ambiguous from these fields alone. They must not be presented as a measured
false-negative count or used to calculate recall.

All 14 unmatched opening candidates lacked a corresponding hit reaction. Ten
were one-percent offscreen-looking increments, consistent with magnifier damage;
the other four were non-reactive damage. Their precise causes were not established
by video review. A percent increase and a persistent `lastHitBy` value alone are
insufficient evidence of an opening.

## Findings and corrections

Frame numbers below are sanitized references to the deterministic local sample;
they identify no player or replay file. Slots are zero-based.

| Trace evidence | Previous behavior | Correction |
| --- | --- | --- |
| Sample 0, slot 1, frame 1562: fighter root briefly dipped below the floor near X=39 before landing at center stage | Started an offstage episode and could absorb later onstage interactions | Shallow negative Y only counts close to a stage edge; otherwise below-stage detection requires Y below -20. Horizontal edge detection remains available. |
| Sample 0, frames 2015–2083: damage → missed tech → slide-off → ledge; sample 24, frames 7562–7658: tech roll → slide-off just beyond the lip → ledge | Launch context expired during forced movement; the horizontal tolerance could also miss a close slide-off | Preserve launch context through knockdown, tech and passive falling/landing. A later grounded action clears it. Include shallow below-edge evidence within four units of the edge and forced direct ledge catches. |
| Sample 3, frame 2140; sample 8, frames 3843 and 3903: percent increments without a reaction | Stale `lastHitBy` could manufacture a fresh recovery contact or contest | Require a damage/capture reaction or hitlag in addition to attributed percent increase. |
| Sample 6, frames 7689 and 7697: ledge catch followed by ledge jump | The ledge animation's low root position could turn the prior approach into “mixed” | Stop route sampling at the first ledge catch or onstage landing. Subsequent ledge options do not rewrite the approach. |
| Sample 1, frames 1163–1212: grounded movement on Yoshi's sloped outer floor | Return detection waited for the player to walk toward center stage | Allow the shallow floor-height tolerance needed for the slope while continuing to exclude Randall below the stage. |
| Sample 1, frame 6168: non-contact onstage attack about 108 units from the recovering player | Horizontal proximity alone counted a contest despite large vertical separation | Require two-dimensional proximity for an unconfirmed attack; confirmed contacts remain usable. Ledge holds and offstage presence are only added while the opponent is approaching. |
| Sample 1, slot 0, frame 429: attempted grab, several dash/turn actions, then captured | Labeled the opening with the earlier grab | Explicit walk/dash/turn/run/crouch actions update movement context. Only idle/fall preserve a recently finished action briefly. |

Each correction has a minimized synthetic regression in
`scripts/verify-recovery-interactions.mjs` or
`scripts/verify-punish-context.mjs`. These fixtures contain invented values and no
raw replay data.

Diagnostic counts before and after the corrections:

| Diagnostic | Before | After |
| --- | ---: | ---: |
| Starts below the floor but horizontally inside the main stage | 77 | 1 |
| “Low” first appeared only after a prior ledge catch in a high approach | 15 | 0 |
| First unconfirmed onstage contest observed more than 60 units away | 27 | 0 |

The remaining horizontally-inside start is near Yoshi's edge and proceeds into an
actual slide-off (sample 5, frames 12015–12027). The before/after counts are
diagnostics, not an accuracy score. Some old false starts remained unpublished;
others incorrectly attached later events to an earlier episode.

Positive trace checks also included a high return after an offstage jump/aerial
(sample 0, frames 6481–6614), a low recovery ending in stock loss while the opponent
used offstage movement and held ledge (sample 0, frames 7232–7446), and a distant
uncontested launch/death (sample 2, frames 5291–5356). The last case is retained as
an unclassified recovery route and an uncontested death, not credited as a
successful edgeguard. Shield-to-grab, aerial-to-hit and direct movement-to-hit
traces agreed with the documented opening-context categories.

## Interpretation limits

- The approach route is sampled outside damage/capture animations near the edge.
  It describes observed movement, not the player's intended recovery choice.
- Reaching ledge is a separate milestone. A return needs a landing followed by
  30 uninterrupted qualifying onstage frames. It is not proof of invulnerability
  or mechanical actionability on every frame.
- “Opponent died during a contest” does not prove that holding ledge, a nearby
  attack or offstage presence caused the death. Tactics can remain mixed or
  unclassified; uncontested deaths are separate.
- Opening context describes the preceding action and subsequent grouped damage.
  It does not prove a whiff, a guaranteed punish, or a causal mistake.
- Seven sampled Stadium games remain unavailable for recovery because explicit
  frozen-stage evidence was absent. Other metrics still have their own coverage.
- There is no blind labeled holdout set or video-based precision/recall estimate.
  Experimental benchmarks must retain this qualification.

## Sources and validation

Replay field meanings were checked against the primary
[Slippi replay specification](https://github.com/project-slippi/slippi-wiki/blob/master/SPEC.md#post-frame-update).
Stage edges use the measured ground-edge coordinates in
[libmelee's stage data](https://github.com/altf4/libmelee/blob/master/melee/stages.py).
Common action states, including slide-off, tech, capture and ledge states, were
cross-checked against
[libmelee's action enumeration](https://github.com/altf4/libmelee/blob/master/melee/enums.py)
and [slippi-js state definitions](https://github.com/project-slippi/slippi-js/blob/master/src/common/stats/common.ts).

The final recovery and opening-context regression scripts pass. The application
TypeScript check also passes. Earlier verification on 12 spread real replays
established header invariants and full-record equality between bounded and
retained parser paths; that equality is pipeline validation, not semantic
classification validation.
