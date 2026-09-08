import { CURRENT_STATS_VERSION } from "./types";
import type { Account, ActionCounts, GameRecord, MoveAgg, PlayerSide, TechCounts } from "./types";
import { INCLUDED_STAGE_IDS } from "./config";

/**
 * Plausible per-move landed/damage/kill aggregates (keyed by Melee attack ID,
 * matching the parser). The demo player has a deliberate tell for the move-
 * impact analysis: side-B spam swells in losses, dair/bair carry wins.
 */
function mkMoveStats(rand: () => number, minutes: number, kills: number, totalDamage: number, isMe: boolean, iWin: boolean, lcRate: number): Record<number, MoveAgg> {
  // [moveId, weight, avgDmgPerHit]
  const mix: [number, number, number][] = [
    [2, 1.6, 3], // jab
    [6, 0.8, 8], // dash attack
    [7, 0.6, 9], // ftilt
    [8, 0.9, 8], // utilt
    [9, 1.0, 9], // dtilt
    [10, 0.7, 15], // fsmash
    [11, 0.6, 14], // usmash
    [12, 0.7, 13], // dsmash
    [13, 3.0, 11], // nair
    [14, 1.2, 8], // fair
    [15, 2.2, 12], // bair
    [16, 1.1, 10], // uair
    // dair carries wins and side-b is the loss habit, but only by enough that
    // the per-game jitter below still overlaps the two halves. Wider splits
    // than this (they were 3.4/2.4 and 0.7/2.6) separate so cleanly that the
    // median split lands on 100% and 13% win rates, which is a number real
    // replays cannot produce and reads as a broken stat rather than a planted
    // one. The signal has to survive the coach's gates without announcing that
    // it was written rather than played.
    [17, isMe ? (iWin ? 2.9 : 2.5) : 2.0, 12], // dair — carries wins
    [18, isMe ? 5.5 : 2.5, 3], // neutral-b (laser: lots of hits, tiny damage)
    [19, isMe ? (iWin ? 1.85 : 2.15) : 1.0, 9], // side-b — the loss habit
    [53, 0.5, 5], // fthrow
    [55, 0.7, 5], // uthrow
    [56, 0.9, 6], // dthrow
  ];
  const out: Record<number, MoveAgg> = {};
  let rawDmg = 0;
  for (const [id, w, dmgPer] of mix) {
    const landed = Math.round(minutes * w * (0.7 + rand() * 0.6));
    if (landed <= 0) continue;
    const damage = landed * dmgPer * (0.8 + rand() * 0.4);
    // Aerials get L-cancel counts: attempts exceed landed (whiffs count too),
    // per-move rate jitters around the game rate — dair runs a little worse.
    let lcSuccess = 0, lcFail = 0;
    if (id >= 13 && id <= 17) {
      const attempts = Math.round(landed * (1.1 + rand() * 0.5));
      const rate = Math.min(0.98, Math.max(0.2, lcRate + (rand() - 0.5) * 0.12 - (id === 17 ? 0.05 : 0)));
      lcSuccess = Math.round(attempts * rate);
      lcFail = attempts - lcSuccess;
    }
    out[id] = { landed, damage, kills: 0, killPctSum: 0, openings: 0, openingDmg: 0, lcSuccess, lcFail };
    // Attempts are tracked for normals + aerials only, mirroring the parser.
    if ((id >= 2 && id <= 17) || id === 6) out[id].attempts = Math.round(landed * (1.2 + rand() * 0.6));
    rawDmg += damage;
  }
  // Scale damages so the per-move sum matches the game's totalDamage.
  const scale = rawDmg > 0 ? totalDamage / rawDmg : 0;
  for (const a of Object.values(out)) a.damage = +(a.damage * scale).toFixed(1);
  // Kills go to the plausible closers; openings mostly to neutral tools.
  const killers = [15, 17, 10, 11, 16].filter((id) => out[id]);
  for (let k = 0; k < kills && killers.length; k++) {
    // !: rand() < 1 keeps the index in [0, length), and the filter above guarantees out[id] exists.
    const a = out[killers[Math.floor(rand() * killers.length)]!]!;
    a.kills++;
    a.killPctSum += 75 + rand() * 65;
  }
  const openers = [13, 17, 18, 9, 56].filter((id) => out[id]);
  const openings = Math.floor(6 + rand() * 10);
  for (let o = 0; o < openings && openers.length; o++) {
    // !: same in-bounds/filter argument as killers above.
    const a = out[openers[Math.floor(rand() * openers.length)]!]!;
    a.openings++;
    a.openingDmg += 12 + rand() * 28;
  }
  return out;
}

/** Plausible per-game action counts, scaled by game length; `tech` in [0,1] raises movement actions. */
function mkActions(rand: () => number, minutes: number, tech: number): ActionCounts {
  const per = (base: number, spread: number) => Math.round(minutes * (base + rand() * spread));
  return {
    rolls: per(4 - tech * 2, 4),
    airDodges: per(2, 3),
    spotDodges: per(1, 2.5),
    wavedashes: per(6 + tech * 10, 8),
    wavelands: per(2 + tech * 4, 3),
    dashDances: per(12 + tech * 14, 10),
    ledgeGrabs: per(1.5, 2),
    crouchCancels: per(0.2 + tech * 1.2, 1.2),
    grabs: per(2.5, 2.5),
  };
}

/** Plausible tech outcomes, scaled by game length; directions are relative to the opponent. */
function mkTechs(rand: () => number, minutes: number, tech: number): TechCounts {
  const groundAttempts = Math.round(minutes * (2.8 + tech * 3.2 + rand() * 3.5));
  const groundRate = Math.min(0.96, Math.max(0.35, 0.55 + tech * 0.3 + (rand() - 0.5) * 0.16));
  const groundSuccess = Math.round(groundAttempts * groundRate);
  const inPlace = Math.min(groundSuccess, Math.round(groundSuccess * (0.28 + rand() * 0.2)));
  const toward = Math.min(groundSuccess - inPlace, Math.round(groundSuccess * (0.2 + rand() * 0.22)));
  const away = groundSuccess - inPlace - toward;
  const wallAttempts = Math.round(minutes * (0.15 + rand() * 0.55));
  const wallSuccess = Math.round(wallAttempts * Math.min(0.92, Math.max(0.3, groundRate - 0.08 + (rand() - 0.5) * 0.18)));
  return {
    inPlace,
    toward,
    away,
    missed: groundAttempts - groundSuccess,
    wallSuccess,
    wallMissed: wallAttempts - wallSuccess,
  };
}

// Deterministic PRNG so the demo dashboard is stable between loads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_CODE = "DEMO#420";
/** A second account, so demo mode exercises the multi-account views too. */
export const DEMO_ALT_CODE = "SMURF#7";

export const DEMO_ACCOUNTS: Account[] = [
  { code: DEMO_CODE, label: "Main" },
  { code: DEMO_ALT_CODE, label: "Alt" },
];

/**
 * Which account played game `i`. Derived from the index rather than the PRNG so
 * adding this didn't shift every downstream random draw, and blocked rather
 * than sprinkled because people play a stretch on one account, not alternate
 * game to game — which is what makes the Sessions view look right.
 */
const onAltAccount = (i: number): boolean => Math.floor(i / 40) % 4 === 3;

interface Rival {
  code: string;
  name: string;
  chars: number[];
  skill: number; // demo player's win prob vs them
  weight: number;
}

const RIVALS: Rival[] = [
  { code: "FOXG#0", name: "20GX", chars: [2], skill: 0.38, weight: 18 },
  { code: "MARF#33", name: "tippercity", chars: [9], skill: 0.55, weight: 14 },
  { code: "PUFF#88", name: "restzone", chars: [15], skill: 0.62, weight: 11 },
  { code: "FALC#123", name: "knee4days", chars: [0], skill: 0.58, weight: 10 },
  { code: "SHEK#7", name: "needle.exe", chars: [19, 18], skill: 0.44, weight: 9 },
  { code: "PECH#2", name: "turnipmath", chars: [12], skill: 0.51, weight: 8 },
  { code: "ICSY#11", name: "wobbleswobbles", chars: [14], skill: 0.66, weight: 6 },
  { code: "SAMU#909", name: "upBoutOfHere", chars: [16], skill: 0.71, weight: 5 },
  { code: "GANN#66", name: "dorfdaddy", chars: [25], skill: 0.74, weight: 5 },
  { code: "LUIG#31", name: "wavelander", chars: [7], skill: 0.6, weight: 4 },
  { code: "YOSH#5", name: "parryking", chars: [17], skill: 0.57, weight: 4 },
  { code: "DOCM#77", name: "pillzhere", chars: [22], skill: 0.53, weight: 6 },
];

const MY_CHARS = [
  { id: 20, weight: 0.72, edge: 0 }, // Falco main
  { id: 2, weight: 0.2, edge: -0.05 }, // Fox secondary
  { id: 9, weight: 0.08, edge: -0.1 }, // Marth pocket
];

interface Mate {
  code: string;
  name: string;
  char: number;
  synergy: number; // win-prob bump when teaming with them
  weight: number;
}

const MATES: Mate[] = [
  { code: "BUDD#1", name: "sameroom", char: 9, synergy: 0.14, weight: 20 }, // Marth — the good one
  { code: "JIGG#404", name: "sleepytime", char: 15, synergy: 0.04, weight: 12 },
  { code: "SPCE#12", name: "spaceanimal", char: 2, synergy: -0.02, weight: 9 },
  { code: "RAND#0", name: "pubmate", char: 7, synergy: -0.11, weight: 5 }, // randoms drag it down
];

function pickWeighted<T extends { weight: number }>(rand: () => number, items: T[]): T {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1]!; // callers always pass non-empty const arrays
}

export function generateDemoRecords(count = 1600, seed = 20260716): GameRecord[] {
  const rand = mulberry32(seed);
  const records: GameRecord[] = [];
  const start = Date.now() - 365 * 86_400_000;

  // Games arrive in realistic sessions (a burst of games, then hours or days
  // of nothing) so the Sessions/tilt view has structure to find.
  let sessionGamesLeft = 0;
  let clockMs = start;

  // Simulate improvement over the year: win prob drifts up ~8 points.
  for (let i = 0; i < count; i++) {
    const t = i / count;
    if (sessionGamesLeft <= 0) {
      sessionGamesLeft = 6 + Math.floor(rand() * 14);
      clockMs = start + t * 364 * 86_400_000 + rand() * 6 * 3_600_000;
    }
    sessionGamesLeft--;
    const playedAt = new Date(clockMs);
    const rival = pickWeighted(rand, RIVALS);
    const mine = pickWeighted(rand, MY_CHARS.map((c) => ({ ...c, weight: c.weight * 100 })));
    const oppChar = rival.chars[Math.floor(rand() * rival.chars.length)]!; // rand() < 1, chars non-empty
    const pWin = Math.min(0.85, Math.max(0.15, rival.skill + mine.edge + t * 0.08 + (rand() - 0.5) * 0.06));
    const iWin = rand() < pWin;

    const durationFrames = Math.floor((90 + rand() * 240) * 60);
    // Advance the session clock: game length plus queue/rematch downtime.
    clockMs += (durationFrames / 60) * 1000 + (30 + rand() * 150) * 1000;
    const minutes = durationFrames / 3600;
    const myKills = iWin ? 4 : Math.floor(rand() * 4);
    const oppKills = iWin ? Math.floor(rand() * 4) : 4;
    const lcAttempts = Math.floor(minutes * (26 + rand() * 14));
    const lcRate = Math.min(0.98, 0.68 + t * 0.16 + (rand() - 0.5) * 0.1);

    const myCode = onAltAccount(i) ? DEMO_ALT_CODE : DEMO_CODE;

    const mkSide = (kills: number, taken: number, isMe: boolean): PlayerSide => {
      const techSkill = isMe ? 0.4 + t * 0.5 : 0.3 + rand() * 0.5;
      const acts = mkActions(rand, minutes, techSkill);
      const totalDamage = kills * (95 + rand() * 40);
      return {
        moveStats: mkMoveStats(rand, minutes, kills, totalDamage, isMe, isMe ? iWin : !iWin, isMe ? lcRate : 0.6 + rand() * 0.3),
        port: isMe ? 1 : 2,
        connectCode: isMe ? myCode : rival.code,
        displayName: isMe ? (myCode === DEMO_CODE ? "demo" : "demo alt") : rival.name,
        characterId: isMe ? mine.id : oppChar,
        colorId: 0,
        teamId: null,
        stocksRemaining: kills === 4 ? Math.max(1, 4 - taken) : 0,
        kills,
        totalDamage,
        openingsPerKill: kills > 0 ? +(2.2 + rand() * 3.5 - (isMe ? t * 0.7 : 0)).toFixed(2) : null,
        damagePerOpening: +(18 + rand() * 18 + (isMe ? t * 4 : 0)).toFixed(2),
        inputsPerMinute: Math.floor(isMe ? 340 + t * 90 + rand() * 60 : 260 + rand() * 200),
        neutralWins: Math.floor(6 + rand() * 14),
        counterHits: Math.floor(2 + rand() * 9),
        beneficialTrades: Math.floor(rand() * 3),
        lCancelSuccess: isMe ? Math.floor(lcAttempts * lcRate) : Math.floor(lcAttempts * (0.6 + rand() * 0.3)),
        lCancelFail: isMe ? lcAttempts - Math.floor(lcAttempts * lcRate) : Math.floor(lcAttempts * 0.3),
        grabSuccess: Math.floor(acts.grabs * (0.5 + rand() * 0.35)),
        techs: mkTechs(rand, minutes, techSkill),
        actions: acts,
      };
    };

    const me = mkSide(myKills, oppKills, true);
    const opp = mkSide(oppKills, myKills, false);
    const rare = rand();
    records.push({
      statsVersion: CURRENT_STATS_VERSION,
      id: `demo-${i}`,
      path: `demo/Game_${playedAt.toISOString().replace(/[:.]/g, "")}.slp`,
      playedAt: playedAt.toISOString(),
      durationFrames,
      stageId: INCLUDED_STAGE_IDS[Math.floor(rand() * INCLUDED_STAGE_IDS.length)]!, // rand() < 1 keeps the index in bounds
      gameType: rare < 0.55 ? "ranked" : rare < 0.9 ? "unranked" : "direct",
      isTeams: false,
      players: [me, opp],
      winnerIndex: rare > 0.985 ? null : iWin ? 0 : 1, // ~1.5% indeterminate (quit-outs etc.)
      winnerTeamId: null,
    });
  }
  records.push(...generateDemoTeamRecords(rand, start, Math.round(count * 0.14)));
  return records;
}

/** 2v2 games sharing the demo player's identity, so the Teams view has something to show. */
function generateDemoTeamRecords(rand: () => number, start: number, count: number): GameRecord[] {
  const records: GameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const playedAt = new Date(start + t * 364 * 86_400_000 + rand() * 4 * 3_600_000);
    const mate = pickWeighted(rand, MATES);
    const mine = pickWeighted(rand, MY_CHARS.map((c) => ({ ...c, weight: c.weight * 100 })));
    const rivalA = pickWeighted(rand, RIVALS);
    let rivalB = pickWeighted(rand, RIVALS);
    if (rivalB.code === rivalA.code) rivalB = RIVALS[(RIVALS.indexOf(rivalA) + 1) % RIVALS.length]!; // modulo keeps the index in bounds

    const pWin = Math.min(0.88, Math.max(0.12, 0.5 + mate.synergy + mine.edge + t * 0.06 + (rand() - 0.5) * 0.12));
    const weWin = rand() < pWin;
    const durationFrames = Math.floor((150 + rand() * 300) * 60);

    // 8 team stocks total; the losing team is stocked out.
    const ourStocks = weWin ? 1 + Math.floor(rand() * 4) : 0;
    const theirStocks = weWin ? 0 : 1 + Math.floor(rand() * 4);
    const stocks = [Math.ceil(ourStocks / 2), Math.floor(ourStocks / 2), Math.ceil(theirStocks / 2), Math.floor(theirStocks / 2)];
    const minutes = durationFrames / 3600;

    // Matrices mirror the v7 parser: [attacker][victim], FF on same-team cells.
    // Kill credit must reconcile with stocks lost so kill share sums sanely.
    const dmgMatrix = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const killMatrix = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const mateOf = [1, 0, 3, 2];
    // !: the matrices are 4x4 and every index below (vi, ai, mateOf/enemies entries) is in 0..3.
    for (let vi = 0; vi < 4; vi++) {
      const deaths = 4 - stocks[vi]!;
      const enemies: [number, number] = vi < 2 ? [2, 3] : [0, 1];
      // The demo player carries slightly; enemy credit is otherwise even.
      const pFirst = enemies[0] === 0 ? 0.55 : 0.5;
      for (let d = 0; d < deaths; d++) {
        const ff = rand() < 0.04; // the occasional up-smash nobody talks about
        const ai = ff ? mateOf[vi]! : enemies[rand() < pFirst ? 0 : 1];
        killMatrix[ai]![vi]!++;
      }
      const taken = deaths * (95 + rand() * 35) + rand() * 80;
      const firstShare = 0.35 + rand() * 0.3;
      dmgMatrix[enemies[0]]![vi]! += taken * firstShare;
      dmgMatrix[enemies[1]]![vi]! += taken * (1 - firstShare);
    }
    // FF damage: my teammate's sloppiness scales inversely with synergy.
    dmgMatrix[0]![1]! += 5 + rand() * 12;
    dmgMatrix[1]![0]! += 8 + Math.max(0, 0.15 - mate.synergy) * 90 + rand() * 10;
    dmgMatrix[2]![3]! += 4 + rand() * 8;
    dmgMatrix[3]![2]! += 4 + rand() * 8;

    const mk = (idx: number, teamId: number, code: string, name: string, characterId: number, isMe: boolean): PlayerSide => {
      const enemies = idx < 2 ? [2, 3] : [0, 1];
      const lcAttempts = Math.floor(minutes * (24 + rand() * 12));
      const lcRate = isMe ? Math.min(0.98, 0.68 + t * 0.16 + (rand() - 0.5) * 0.1) : 0.6 + rand() * 0.3;
      const techSkill = isMe ? 0.4 + t * 0.5 : 0.3 + rand() * 0.5;
      const acts = mkActions(rand, minutes, techSkill);
      return {
        port: idx + 1,
        connectCode: code,
        displayName: name,
        characterId,
        colorId: teamId,
        teamId,
        // !: idx and e are in 0..3 against 4-wide stocks/matrices built above.
        stocksRemaining: stocks[idx]!,
        kills: enemies.reduce((s, e) => s + killMatrix[idx]![e]!, 0),
        totalDamage: enemies.reduce((s, e) => s + dmgMatrix[idx]![e]!, 0),
        // Conversion-based stats stay null/zero in doubles, matching the parser.
        openingsPerKill: null,
        damagePerOpening: null,
        inputsPerMinute: Math.floor(isMe ? 330 + t * 90 + rand() * 60 : 250 + rand() * 190),
        neutralWins: 0,
        counterHits: 0,
        beneficialTrades: 0,
        lCancelSuccess: Math.floor(lcAttempts * lcRate),
        lCancelFail: lcAttempts - Math.floor(lcAttempts * lcRate),
        grabSuccess: Math.floor(acts.grabs * (0.5 + rand() * 0.35)),
        techs: mkTechs(rand, minutes, techSkill),
        actions: acts,
      };
    };

    const players: PlayerSide[] = [
      mk(0, 0, DEMO_CODE, "demo", mine.id, true),
      mk(1, 0, mate.code, mate.name, mate.char, false),
      mk(2, 1, rivalA.code, rivalA.name, rivalA.chars[0]!, false), // every RIVALS entry has 1+ chars
      mk(3, 1, rivalB.code, rivalB.name, rivalB.chars[0]!, false),
    ];

    const rare = rand();
    records.push({
      statsVersion: CURRENT_STATS_VERSION,
      id: `demo-teams-${i}`,
      path: `demo/Teams_${playedAt.toISOString().replace(/[:.]/g, "")}.slp`,
      playedAt: playedAt.toISOString(),
      durationFrames,
      stageId: INCLUDED_STAGE_IDS[Math.floor(rand() * INCLUDED_STAGE_IDS.length)]!, // rand() < 1 keeps the index in bounds
      gameType: rare < 0.7 ? "direct" : "unranked", // no ranked doubles matchmaking
      isTeams: true,
      players,
      winnerIndex: null,
      winnerTeamId: rare > 0.98 ? null : weWin ? 0 : 1,
      dmgMatrix,
      killMatrix,
    });
  }
  return records;
}
