// Build-time entry only; never imported by the browser application.
export { parseReplay, parseReplayRetainedForVerification, dropUnreadComputers } from "../../src/lib/parse";
export { watchSpecialMoveFrameIntegrity } from "../../src/lib/specialMoves";
export { readReplayMetadata } from "../../src/lib/replayMetadata";
export { CURRENT_STATS_VERSION, INTERACTION_STATS_VERSION } from "../../src/lib/types";
