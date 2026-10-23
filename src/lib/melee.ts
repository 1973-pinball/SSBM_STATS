// In-game external character IDs used by Slippi. This is the playable roster;
// `INCLUDED_CHARACTER_IDS` in config.ts is the allowlist built from it, and
// it's what actually keeps everything below out of the dashboard.
export const CHARACTERS: Record<number, string> = {
  0: "Captain Falcon",
  1: "DK",
  2: "Fox",
  3: "Game & Watch",
  4: "Kirby",
  5: "Bowser",
  6: "Link",
  7: "Luigi",
  8: "Mario",
  9: "Marth",
  10: "Mewtwo",
  11: "Ness",
  12: "Peach",
  13: "Pikachu",
  14: "Ice Climbers",
  15: "Jigglypuff",
  16: "Samus",
  17: "Yoshi",
  18: "Zelda",
  19: "Sheik",
  20: "Falco",
  21: "Young Link",
  22: "Dr. Mario",
  23: "Roy",
  24: "Pichu",
  25: "Ganondorf",
};

export const STAGES: Record<number, string> = {
  2: "Fountain of Dreams",
  3: "Pokémon Stadium",
  8: "Yoshi's Story",
  28: "Dream Land",
  31: "Battlefield",
  32: "Final Destination",
};

/**
 * The rest of Melee's external character table, kept separate because none of
 * it is selectable in a versus match — a replay reporting one of these is
 * malformed or came from a mod, and the allowlist drops the game before any
 * view sees it. Named anyway so that if one ever does slip through some path
 * that doesn't resolve through `resolveGames`, it reads as "Sandbag" rather
 * than "Char 31". Names match slippi-js's own table.
 */
const NON_PLAYABLE: Record<number, string> = {
  26: "Master Hand",
  27: "Wireframe (Male)",
  28: "Wireframe (Female)",
  29: "Giga Bowser",
  30: "Crazy Hand",
  31: "Sandbag",
  32: "Popo",
};

export const charName = (id: number): string => CHARACTERS[id] ?? NON_PLAYABLE[id] ?? `Char ${id}`;
export const stageName = (id: number): string => STAGES[id] ?? `Stage ${id}`;

/**
 * Melee attack IDs (PostFrame `lastAttackLanded`, as used by slippi-js
 * conversion moves) grouped into the buckets players think in. Jab 1/2/3 and
 * rapid jabs collapse to "Jab"; specials are per-direction (the character
 * context says which move it actually is). Kept local so the main bundle
 * doesn't pull in slippi-js just for names.
 */
const MOVE_GROUPS: [number[], string, string][] = [
  [[2, 3, 4, 5], "jab", "Jab"],
  [[6], "dash", "Dash attack"],
  [[7], "ftilt", "Forward tilt"],
  [[8], "utilt", "Up tilt"],
  [[9], "dtilt", "Down tilt"],
  [[10], "fsmash", "Forward smash"],
  [[11], "usmash", "Up smash"],
  [[12], "dsmash", "Down smash"],
  [[13], "nair", "Neutral air"],
  [[14], "fair", "Forward air"],
  [[15], "bair", "Back air"],
  [[16], "uair", "Up air"],
  [[17], "dair", "Down air"],
  [[18], "neutral-b", "Neutral B"],
  [[19], "side-b", "Side B"],
  [[20], "up-b", "Up B"],
  [[21], "down-b", "Down B"],
  [[50, 51], "getup", "Getup attack"],
  [[52], "pummel", "Pummel"],
  [[53], "fthrow", "Forward throw"],
  [[54], "bthrow", "Back throw"],
  [[55], "uthrow", "Up throw"],
  [[56], "dthrow", "Down throw"],
  [[61, 62], "edge", "Edge attack"],
];

export interface MoveGroup {
  key: string;
  label: string;
}

const MOVE_GROUP_BY_ID = new Map<number, MoveGroup>();
const MOVE_GROUP_LABEL_BY_KEY = new Map<string, string>();
for (const [ids, key, label] of MOVE_GROUPS) {
  MOVE_GROUP_LABEL_BY_KEY.set(key, label);
  for (const id of ids) MOVE_GROUP_BY_ID.set(id, { key, label });
}

const OTHER_MOVE: MoveGroup = { key: "other", label: "Other" };
const ATTEMPT_TRACKED_MOVE_KEYS = new Set([
  "jab", "dash", "ftilt", "utilt", "dtilt", "fsmash", "usmash", "dsmash",
  "nair", "fair", "bair", "uair", "dair",
]);

export const moveGroup = (moveId: number): MoveGroup => MOVE_GROUP_BY_ID.get(moveId) ?? OTHER_MOVE;
export const moveGroupLabel = (key: string): string => MOVE_GROUP_LABEL_BY_KEY.get(key) ?? OTHER_MOVE.label;
/** Slippi's action counter reports initiations only for normals and aerials. */
export const moveGroupTracksAttempts = (key: string): boolean => ATTEMPT_TRACKED_MOVE_KEYS.has(key);

/** Specials use separate per-move capability and measured-game denominators. */
export const specialMoveId = (key: string): 18 | 19 | 20 | 21 | null => {
  if (key === "neutral-b") return 18;
  if (key === "side-b") return 19;
  if (key === "up-b") return 20;
  if (key === "down-b") return 21;
  return null;
};
