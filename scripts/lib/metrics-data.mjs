// Metric definitions shown by the Metrics guide dialog and by the static
// /metrics page the build renders for search engines.
//
// Plain JS with a .d.mts sibling for the same reason as gif-draw/gif-encode:
// the identical module is imported by the browser (MetricsGuide.tsx) and by
// Node (scripts/render-seo-pages.mjs), and Node cannot load .ts. One
// definition is the point — a second copy of this prose in a hand-written
// HTML file would drift from the dialog within a release or two.

export const SECTIONS = [
  {
    title: "Results",
    items: [
      {
        term: "CPU games",
        def: "Newly parsed games with a player explicitly marked CPU in the replay are excluded by default, including CPU teammates in doubles. Older games with unknown CPU status stay included. When confirmed CPU games are present, the CPU games filter lets you include them again. No saved games are deleted or reparsed for this filter.",
      },
      {
        term: "Win rate",
        def: "Wins ÷ decided games. Games under 30 seconds, and quit-outs with no determinable result, stay out of the denominator — they read “n/a” in the game log.",
      },
      {
        term: "Your accounts",
        def: "Every connect code you've entered counts as you, pooled by default. Split them with the Account filter, or compare them in Overview's “By account” table. A game between two of your own accounts carries no result: badged “self” in the log, out of win rates and opponent tables.",
      },
      {
        term: "Kills / deaths per game",
        def: "Stocks taken (or lost) per game, averaged over the filtered set. A 4–0 and a last-stock game weigh the same.",
      },
      {
        term: "Damage per game",
        def: "Total percent dealt per game, averaged over the filtered set — including damage on stocks you didn't close out.",
      },
      {
        term: "Streak",
        def: "Your current run of consecutive wins (W) or losses (L) across decided games.",
      },
    ],
  },
  {
    title: "Neutral & punish",
    items: [
      {
        term: "Opening (conversion)",
        def: "Every time you start a punish — a clean neutral win, a counter-attack while escaping theirs, or a trade. It ends when they hit you back or die. Usually several per stock.",
      },
      {
        term: "Openings per kill",
        def: "Openings ÷ kills, and lower is better: 3.0 means three neutral wins per stock you actually take, so two punishes got dropped. Even top players sit around 2–3.",
      },
      {
        term: "Damage per opening",
        def: "Damage dealt ÷ openings — what each neutral win costs them. Low DPO alongside a decent win rate means you win neutral but drop punishes; high means you make it count.",
      },
      {
        term: "Neutral wins",
        def: "Openings from a clean neutral exchange only, excluding counter-hits and trades. The share % is your count ÷ the game total, so over 50% means you won neutral more often than they did.",
      },
      {
        term: "Counter hits",
        def: "Openings earned by hitting the opponent during their punish on you — turning pressure around rather than winning neutral outright.",
      },
      {
        term: "Beneficial trades",
        def: "You both hit at once and the trade favored you: your hit killed and theirs didn't, or yours simply dealt more.",
      },
    ],
  },
  {
    title: "Execution",
    items: [
      {
        term: "L-cancel %",
        def: "Successful L-cancels ÷ attempts, where an attempt is any aerial landing that allowed one. Success halves your landing lag.",
      },
      {
        term: "Tech success",
        def: "Ground tech success is made ground techs ÷ ground tech attempts; wall-tech success is shown separately. The in-place, toward-opponent and away-from-opponent split is a share of successful ground techs, and direction is relative to the opponent rather than stage left/right.",
      },
      {
        term: "Inputs per minute",
        def: "Controller inputs per minute of game time. A speed gauge, not a quality one — high IPM with low damage per opening is just noise.",
      },
      {
        term: "Actions per game",
        def: "Detected movement and defensive actions: rolls, air dodges, spot dodges, wavedashes, wavelands, dash dances, ledge grabs, crouch cancels, and grabs. High roll counts usually signal panic options; wavedash and dash-dance volume tracks movement-heavy play. Compare filters of differing length by the per-minute column.",
      },
      {
        term: "Crouch cancels",
        def: "Hit instances where your percent increased while your immediately previous frame was a crouch/squat state. This is a frame-derived defensive count, not proof that the crouch cancel escaped the whole punish.",
      },
      {
        term: "Grabs",
        def: "All grab attempts, landed and whiffed — standing, dash and out-of-shield together. Shield grabs can't be isolated without frame-level data, a possible future opt-in. The game log drill-down shows landed/attempts with the success rate.",
      },
    ],
  },
  {
    title: "Insights (win model)",
    items: [
      {
        term: "The short version — what to change",
        def: "A ranked coaching list generated after at least 40 decided games. It scans 15 possible findings: opponent matchup, stage ban, stage pick, matchup × stage, tilt, fatigue, cold start, time of day, set deciders, a specific rival, queue mode, your character, move habits, action habits, and recent L-cancel drift. Most findings must clear |z| ≥ 2.0 (roughly a 98% one-sided evidence bar); the broad matchup × stage scan uses 2.5. The five highest scores show first, with every other qualifying finding behind Show more.",
      },
      {
        term: "Recommendation parameters — matchups & stages",
        def: "Opponent matchup: at least 20 decided games. A stage tip inside that matchup needs 8 games and a win rate at least 12 percentage points better than the matchup overall. Standalone stage bans and picks need 30 decided games. A matchup × stage warning needs 15 decided games, a rate at least 12 points below that character matchup, and the stricter z ≤ −2.5 gate.",
      },
      {
        term: "Recommendation parameters — sessions & context",
        def: "Tilt needs 25 decided next-games after two or more consecutive losses; cold start needs 25 session openers; fatigue needs 25 games played after game 15 of a session; a local time-of-day bucket needs 30. Set-decider advice needs 25 game-three deciders and compares against 50%. A rival needs 20 decided games, a mode needs 30, and a weak secondary character needs 30 with at least two characters independently clearing 30.",
      },
      {
        term: "Recommendation parameters — habits & execution",
        def: "A move habit must average at least 5% of landed hits, cover at least 60 heavy/light games, and show a heavy-usage win rate at least 8 percentage points worse with z ≤ −2.0. An action habit uses the same 60-game, 8-point and z gates, plus at least 0.5 uses/min. L-cancel drift needs 150 total games and compares the last 50 with career, surfacing at a 2-point change. Findings rank by effect size × √sample; move/action scores are halved and execution drift is doubled so unlike units do not dominate the list.",
      },
      {
        term: "Odds × per +1 SD",
        def: "From a logistic regression on your filtered games: one standard deviation above your average on that metric multiplies the odds of a win by this much, holding the other rows fixed. Above 1× favours wins, below 1× losses. The shift columns restate it in percentage points near an even game.",
      },
      {
        term: "Raw vs adjusted shift",
        def: "Raw is the plain association. Adjusted re-fits with fixed effects for the opponent (regulars with 15+ games), your character, the stage and a time trend, so it asks whether the metric mattered within one context. An effect that collapses under adjustment rode on context rather than driving wins — adjusted is the column that answers “what should I practice”.",
      },
      {
        term: "Evidence",
        def: "How distinguishable the effect is from noise at your sample size: strong ≈ p<0.01, moderate ≈ p<0.05, weak ≈ p<0.1. Faded rows could easily be chance — more games sharpen them.",
      },
      {
        term: "Win rate by quartile",
        def: "The model-free cross-check: games sorted by the metric, cut into four buckets, win rate for each. Disagreement with the regression usually means the effect belongs to a correlated metric the model controls for.",
      },
      {
        term: "Habits vs outcome-linked",
        def: "Habits (L-cancel %, movement per minute) are practicable. Outcome-linked stats (openings/kill, neutral-win share) partly are the win, so they dominate any model without saying what to change — hence off by default. All of it is correlation across your own games, and none of it accounts for opponent strength.",
      },
    ],
  },
  {
    title: "Teams (2v2)",
    items: [
      {
        term: "Team win rate",
        def: "Decided per team, not per player — doubles has no individual result. The same 30-second and indeterminate rules apply.",
      },
      {
        term: "Stocks taken / lost",
        def: "Your duo's combined stocks taken from (or lost to) the enemy team, from end-of-game state. Self-destructs count for the other team; the Damage & FF tab splits captures per player.",
      },
      {
        term: "Enemy team includes",
        def: "A game counts once for each distinct character on the enemy team, so a double-Fox team counts Fox once and the rows sum above the game total.",
      },
    ],
  },
  {
    title: "Teams — Damage & FF",
    items: [
      {
        term: "Damage attribution",
        def: "Slippi's stat engine computes nothing for 4-player games, so this dashboard runs its own frame pass, crediting damage and stock losses to the victim's last-hit-by player — the convention other Slippi tools use. Self-destructs credit no one, and attribution can be wrong when someone dies without being touched recently.",
      },
      {
        term: "My / teammate damage per game",
        def: "Damage dealt to the enemy team only — friendly fire is tracked separately and never mixed in. Kills per game are enemy stocks captured, same rule.",
      },
      {
        term: "Damage share / kill share",
        def: "Your slice of the duo's enemy damage (or captures). 50% is an even carry; above means you're the engine, below the passenger — though roles like support Puff versus closer Fox legitimately skew it.",
      },
      {
        term: "Friendly fire (FF)",
        def: "Damage dealt to your own teammate, shown per game in both directions. FF kills are the times one of you took the other's stock. Both come from the same-team cells of the damage matrix.",
      },
      {
        term: "Enemy focus on me",
        def: "Of all the damage the enemy team dealt your duo, the share aimed at you. Above 50% means they're targeting you.",
      },
      {
        term: "Execution — me vs teammate",
        def: "L-cancel %, tech success, inputs/min and movement counts per player, from running the singles machinery pairwise across teams. “Teammate” aggregates whoever you queued with under the current filters.",
      },
    ],
  },
  {
    title: "Counterpicks (Stages tab)",
    items: [
      {
        term: "Stage × opponent character",
        def: "Your win rate on each stage against each opponent character — a counterpick sheet: within a character's column, green stages are picks and red are bans. Faded cells are below the sample threshold; treat them as anecdotes.",
      },
      {
        term: "My character × stage",
        def: "The same grid keyed on your own character, showing where each of yours over- or under-performs. Clicking any cell in either grid scopes the whole dashboard to that stage and character.",
      },
    ],
  },
  {
    title: "Sessions & tilt",
    items: [
      {
        term: "Session",
        def: "A run of games where each starts within 30 minutes of the previous one ending; a longer gap starts a new one. So ranked with drink breaks is a single session, morning and evening play two. It tracks time at the setup, not the account — swapping accounts mid-evening keeps it one.",
      },
      {
        term: "Win rate by position in session",
        def: "Every session stacked up: your record in games 1–5, 6–10 and so on, against your baseline. A red tail means marathon sessions are donating rating.",
      },
      {
        term: "Tilt check",
        def: "Win rate by the streak you entered on, within one session: after a win, 2+ wins, a loss, 2 losses, 3+ losses. “After 3+ losses” far below baseline is the signature of tilt. Streaks reset between sessions; indeterminate games neither extend nor break one.",
      },
      {
        term: "Baseline",
        def: "Your overall win rate across decided games in the current filter — what the “vs baseline” columns compare against.",
      },
    ],
  },
  {
    title: "Records",
    items: [
      {
        term: "Streaks & bests",
        def: "Every record respects the current filters, so you can ask for your best streak on one character or in one time range. Dates are when the record was set — for streaks, when the run ended.",
      },
      {
        term: "Perfect win",
        def: "A win with all 4 of your stocks intact.",
      },
      {
        term: "Best L-cancel day",
        def: "Highest single-day L-cancel rate among days with at least 100 attempts, so one clean three-aerial game can't take the crown.",
      },
      {
        term: "Nemesis / favorite victim",
        def: "The opponent (by connect code) you've lost to most, and the one you've beaten most. Raw counts, not rates — your nemesis is usually just whoever you play most.",
      },
      {
        term: "FF grudge",
        def: "The teammate who friendly-fires you hardest per game, and the one you damage most — each needing at least 5 games together, so a single Falco dair doesn't define a friendship.",
      },
    ],
  },
];
