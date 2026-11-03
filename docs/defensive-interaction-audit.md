# Defensive interaction audit — 0.4.9

This is a local action-state, controller-input, and trajectory audit. It does
not claim video review, human gameplay annotation, or a measured classifier
accuracy rate. No replay files, filenames, player identities, or recorded game
dates are included in this report.

## Sample and method

The local library contained 3,001 `.slp` files. An evenly spaced 40-file sample
provided 38 singles games. The audit inspected stratified state traces covering
ledge actions, shield-contact responses, other shield exits, grabs, damage,
trades, complete no-hit windows, and interrupted observations. The original
stratified export contained 136 traces; corrected movement examples were then
reviewed with coordinates and landing-frame inputs.

An expanded 200-file spread supplied 184 singles games and located the rare
shield-contact wavedashes missing from the initial sample. The separate audit
interpreter checked raw exits, action sequences, first interaction evidence,
30-frame no-hit windows, and reasons for censoring. It does not invoke the
production classifier's private predicates or Slippi conversion statistics.

| Sample | Events checked | Agreed with explicit rules | Mismatches after corrections | Unsupported/ambiguous |
| --- | ---: | ---: | ---: | ---: |
| 38-game initial spread | 1,440 | 1,427 | 0 | 13 |
| 184-game expanded spread | 7,414 | 7,339 | 0 | 75 |

These are agreement counts against a separate state-based interpretation, not
independent human labels. Unsupported sequences remain **Other / unknown**.
The raw transition scan found no omitted deliberate ledge or shield exits in
either spread; transitions into damage, capture, death, or forced slide-off
were deliberately excluded from choice counts.

## Corrections found in actual replays

- **Instantaneous wavedashes:** post states can go directly from jump to
  special landing within one simulation frame. The detector now accepts an
  observed jump/fall pre-state plus digital L/R input on that landing frame.
  A special landing alone remains insufficient. Six initial-sample wavedashes
  were previously labeled jumps.
- **Ledge sequence duration:** 15 frames cut off continuous ascents from below
  stage height. Ledge sequences now use the 30-frame outcome window; shield
  sequences remain 15 frames. The initial sample recovered nine ledgedashes,
  15 regrabs, and 56 additional drop aerials.
- **Platform shield drops:** common Pass state 244 now belongs to Drop / fall.
- **Forced shield slide-off:** state 251 is not a deliberate shield exit.
  Twelve such false choice events were removed from the initial sample.

Representative sanitized evidence:

| Replay index / frames | Observed evidence | Result |
| --- | --- | --- |
| 0 / 3282–3309 | Fall → double jump → air dodge → grounded special landing | Ledgedash; old 15-frame cutoff missed it |
| 538 / 5241–5246 | Jumpsquat → jump → special landing; landing input includes L | Wavedash despite no air-dodge post state |
| 153 / 16242–16271 | Ledge drop → double jump → ledge catch | Regrab at the end of the window |
| 538 / 2951–2957 | Shield damage precedes grab; opponent enters capture without percent gain | OOS grab hit |
| 1538 / 1999–2024 | Both players gain damage and enter damage states on the same frame | Trade |
| 693 / 7444–7473 | Shield damage → jump → air dodge → landing | Contact-OOS wavedash, no hit/grab in window |
| 1658 / 7381–7406 | Shield damage → jumpsquat → immediate landing with L/R → down tilt hit | Contact-OOS wavedash, outgoing first interaction |

State meanings were cross-checked against the
[libmelee action enum](https://github.com/altf4/libmelee/blob/master/melee/enums.py),
and same-frame landing behavior against
[EscapeAir collision handling](https://github.com/doldecomp/melee/blob/master/src/melee/ft/kinds/ftCommon/ftCo_EscapeAir.c).
Platform-drop behavior is also represented in
[Pass handling](https://github.com/doldecomp/melee/blob/master/src/melee/ft/kinds/ftCommon/ftCo_Pass.c).

## Reproduction and limits

Run `node --experimental-strip-types scripts/audit-defensive-replays.mjs <local-replay-folder> 40 audit.local`.
The optional output contains sanitized frame intervals and state/trajectory
summaries. `scripts/verify-defensive-interactions.mjs` includes minimized
synthetic regression cases for the corrections; raw replays are not fixtures.

The outcome remains the first hit/grab observed within 30 frames of the choice.
No hit is not proof of safety: slow ledge options can still be in progress when
the window ends. Attribution describes what followed a choice, not whether a
punish was guaranteed. Character-specific specials and ambiguous sequences
remain unknown; the sample cannot establish accuracy for every character,
stage situation, or rare interaction.

## Schema 9 addendum: latest 150 local Marth games

All 150 games parsed successfully with defensive coverage. The sample contained
544 shield-contact OOS choices and 1,634 other shield exits. It had zero completed
OOS wavedashes and one wavedash among other shield exits. Zero remains a measured
result; a jump followed by an air dodge needs an observed special landing within
the sequence window to count as a wavedash. An interrupted or airborne-only
sequence remains a jump.

**Drop → aerial** means a normal aerial attack, including G&W's character-specific
aerial states; it excludes specials. **Drop → regrab** requires an uninterrupted
drop/jump return to ledge. Fire Fox stalls pass through a special and remain
**Other / unknown**, rather than being counted as aerials or regrabs. These
boundaries have synthetic regression cases.

The experimental **C-stick input observed** count samples the shield-exit frame
for jumps, jump-derived aerials/wavedashes, rolls and spot dodges. Both recorded
axes must be finite; either axis reaching an absolute value of 0.2875 counts as
input observed. This uses the [Slippi input counter's deadzone](https://github.com/project-slippi/slippi-js/blob/master/src/common/stats/inputs.ts),
not an action-trigger threshold. Missing inputs are excluded from the denominator,
while recorded neutral inputs count as measured samples. A jump sequence retains
its original exit-frame sample when subsequently classified as an aerial or wavedash.

| Eligible choices | Recorded input samples | C-stick input observed |
| --- | ---: | ---: |
| Shield-contact OOS | 138 | 0 |
| Other shield exits | 575 | 45 |

The 45 observations comprise 38 forward rolls, three backward rolls, two spot
dodges, one jump and one jump-to-aerial. This is input presence, including held
input, and does not establish a buffered action or which control caused it.
The [Slippi pre-frame specification](https://github.com/project-slippi/slippi-wiki/blob/master/SPEC.md#pre-frame-update)
records both sticks and buttons. The decompiled [jump](https://github.com/doldecomp/melee/blob/master/src/melee/ft/kinds/ftCommon/ftCo_Jump.c)
and [dodge](https://github.com/doldecomp/melee/blob/master/src/melee/ft/kinds/ftCommon/ftCo_Escape.c)
handlers permit competing inputs, so causal attribution requires more than observing
the C-stick. These aggregate and raw-state checks are not independent video ground
truth or a precision/recall estimate.
