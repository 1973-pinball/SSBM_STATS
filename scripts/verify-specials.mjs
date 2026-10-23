/** Source-audited all-character special activation fixtures; no raw replays. */
import assert from "node:assert/strict";
import { Character, Command, GameMode, SlpParser } from "@slippi/slippi-js";
import { SPECIAL_MOVE_IDS, getSpecialMoveCapability, createSpecialMovesAccumulator, addSpecialMovesFrame, finishSpecialMovesAccumulator, watchSpecialMoveFrameIntegrity } from "../src/lib/specialMoves.ts";
import { createDownBAccumulator, addDownBFrame, finishDownBAccumulator } from "../src/lib/downBSpecial.ts";

// Independent expected constants from pinned decomp Enter callbacks, named
// slippi-js character-select IDs and internal FighterKind order.
const roster = [
  [Character.MARIO, 0, [343,345,347], [20]],
  [Character.FOX, 1, [341,347,353], [19,20]],
  [Character.CAPTAIN_FALCON, 2, [347,349,353], [18,19]],
  [Character.DONKEY_KONG, 3, [369,379,381], [18,19,20]],
  [Character.KIRBY, 4, [353,383,385], [19]],
  [Character.BOWSER, 5, [341,347,359], [20]],
  [Character.LINK, 6, [344,350,356], [20]],
  [Character.SHEIK, 7, [341,349,355], []],
  [Character.NESS, 8, [348,356,358], []],
  [Character.PEACH, 9, [365,354,361], []],
  [Character.ICE_CLIMBERS, 10, [341,343,347], []],
  [Character.PIKACHU, 12, [341,343,353], [19,20]],
  [Character.SAMUS, 13, [343,349,353], [20]],
  [Character.YOSHI, 14, [346,360,364], [19]],
  [Character.JIGGLYPUFF, 15, [346,363,365], [18,19]],
  [Character.MEWTWO, 16, [341,351,353], []],
  [Character.LUIGI, 17, [341,343,355], [19,20]],
  [Character.MARTH, 18, [341,349,367], [18,19,20]],
  [Character.ZELDA, 19, [341,343,349], [18,20]],
  [Character.YOUNG_LINK, 20, [344,350,356], [20]],
  [Character.DR_MARIO, 21, [343,345,347], [20]],
  [Character.FALCO, 22, [341,347,353], [19,20]],
  [Character.PICHU, 23, [341,343,353], [19]],
  [Character.GAME_AND_WATCH, 24, [353,355,373], [19,20]],
  [Character.GANONDORF, 25, [347,349,353], [18,19]],
  [Character.ROY, 26, [341,349,367], [18,19,20]],
];
assert.deepEqual(roster.map(x=>x[0]).sort((a,b)=>a-b), Array.from({length:26},(_,i)=>i));
assert.deepEqual(SPECIAL_MOVE_IDS,[18,19,20,21]);
const post = (internalCharacterId, actionStateId=14, actionStateCounter=0, extra={}) => ({
  internalCharacterId, actionStateId, actionStateCounter, isFollower:false,
  percent:0, stocksRemaining:4, lastAttackLanded:0, lastHitBy:255, hitlagRemaining:0, ...extra,
});
const full = (attempts,hitAttempts=0,noHitAttempts=attempts-hitAttempts,incompleteAttempts=0) => ({attempts,hitAttempts,noHitAttempts,incompleteAttempts});
function run(external, internal, sequence=[], {close=true,first=-123}={}) {
  const players=[{playerIndex:0,characterId:external},{playerIndex:1,characterId:Character.MARTH}];
  const acc=createSpecialMovesAccumulator(players), legacy=createDownBAccumulator(players);
  let frame=first;
  const feed=(a,b=post(18))=>{
    const entry={frame:frame++,players:{0:{post:a},1:{post:b}}};
    addSpecialMovesFrame(acc,entry); addDownBFrame(legacy,entry);
  };
  feed(post(internal));
  for(const sample of sequence) feed(...sample);
  if(close) feed(post(internal));
  const result=finishSpecialMovesAccumulator(acc).get(0);
  assert.deepEqual(result[21],finishDownBAccumulator(legacy).get(0),"Down B stays byte-equivalent to v4");
  return {acc,feed,result};
}
const seq=(internal,states)=>states.map(state=>[post(internal,...(Array.isArray(state)?state:[state,0]))]);
// Actual-library command ordering: valid rollback stays after the finalized
// boundary; malformed raw writes can replace old frames without a FRAME event.
function frameSource(version="3.19.1") {
  const parser=new SlpParser();
  const integrity=watchSpecialMoveFrameIntegrity(parser);
  parser.handleCommand(Command.GAME_START,{slpVersion:version,gameMode:GameMode.ONLINE,players:[{playerIndex:0,type:0},{playerIndex:1,type:0}]});
  const write=(frame,bookend=true)=>{
    for(const playerIndex of [0,1]) {
      parser.handleCommand(Command.PRE_FRAME_UPDATE,{frame,playerIndex,isFollower:false});
      parser.handleCommand(Command.POST_FRAME_UPDATE,{frame,playerIndex,...post(playerIndex===0?1:18)});
    }
    if(bookend) parser.handleCommand(Command.FRAME_BOOKEND,{frame,latestFinalizedFrame:frame-7});
  };
  for(let frame=-123;frame<=-100;frame++) write(frame,version!=="2.0.1");
  return {parser,integrity,write};
}
assert.equal(watchSpecialMoveFrameIntegrity(undefined)(),null);
assert.equal(watchSpecialMoveFrameIntegrity({})(),null);
for(const version of ["2.0.1","3.19.1"]) {
  const source=frameSource(version);
  source.parser.handleCommand(Command.GAME_END,{gameEndMethod:2});
  assert.equal(source.integrity(),-100,`${version} ordinary repeated pre/post updates stay valid`);
}
const rollback=frameSource();
rollback.write(-103); // -103 remains newer than the finalized -107 boundary.
for(let frame=-102;frame<=-99;frame++) rollback.write(frame);
rollback.parser.handleCommand(Command.GAME_END,{gameEndMethod:2});
assert.equal(rollback.integrity(),-99,"ordinary rollback before finalization remains measurable");
for(const command of [Command.PRE_FRAME_UPDATE,Command.POST_FRAME_UPDATE]) {
  const corrupt=frameSource();
  corrupt.parser.handleCommand(command,{frame:-120,playerIndex:0,...post(1,360)}); // deliberately no bookend
  corrupt.write(-99);
  corrupt.parser.handleCommand(Command.GAME_END,{gameEndMethod:2});
  assert.equal(corrupt.parser.lastFinalizedFrame,-99);
  assert.equal(corrupt.integrity(),null,"raw finalized-frame rewrite remains invalid despite a later complete terminal frame");
}
for(const [external,internal,starts,direct] of roster) {
  for(const [index,moveId] of [18,19,20].entries()) {
    const capability=getSpecialMoveCapability(external,moveId);
    assert.equal(capability.attempts,true,`${external}/${moveId} supported`);
    assert.equal(capability.outcomes,direct.includes(moveId),`${external}/${moveId} direct outcome policy`);
    assert.equal(capability.reason===null,direct.includes(moveId));
    assert.deepEqual(run(external,internal).result[moveId],direct.includes(moveId)?full(0):{attempts:0},`${external}/${moveId} measured zero`);
    assert.deepEqual(run(external,internal,seq(internal,[[starts[index],0],[starts[index],1]])).result[moveId],direct.includes(moveId)?full(1):{attempts:1},`${external}/${moveId} one activation`);
    // An unrelated special never borrows damage attribution from this one.
    const wrongMove=moveId===18?19:18;
    const sample=[[post(internal,starts[index],0,{lastAttackLanded:wrongMove,instanceId:8}),post(18,75,0,{percent:4,lastHitBy:0,instanceHitBy:8})]];
    assert.deepEqual(run(external,internal,sample).result[moveId],direct.includes(moveId)?full(1):{attempts:1});
    if(direct.includes(moveId)) {
      const hit=[[post(internal,starts[index],0,{lastAttackLanded:moveId,instanceId:8}),post(18,75,0,{percent:4,lastHitBy:0,instanceHitBy:8})],
        [post(internal,starts[index],1,{lastAttackLanded:moveId,instanceId:8}),post(18,75,1,{percent:8,lastHitBy:0,instanceHitBy:8})]];
      assert.deepEqual(run(external,internal,hit).result[moveId],full(1,1),`${external}/${moveId} multi-hit dedup`);
      assert.deepEqual(run(external,internal,seq(internal,[starts[index]]),{close:false}).result[moveId],full(1,0,0,1));
    }
  }
}
assert.equal(getSpecialMoveCapability(-1,18).attempts,false);
assert.equal(getSpecialMoveCapability(Character.FOX,99).attempts,false);
assert.equal(createSpecialMovesAccumulator([]),null);
assert.equal(createSpecialMovesAccumulator([{playerIndex:0},{playerIndex:0}]),null);
assert.equal(createSpecialMovesAccumulator([{playerIndex:0},{playerIndex:1},{playerIndex:2}]),null);

// Held firing, charge and release are one activation; restarting the actual
// start after idle, or Fox's known terminal fire phase, is a new activation.
assert.deepEqual(run(Character.FOX,1,seq(1,[341,[342,8],342,345,[345,8],345,346])).result[18],{attempts:1});
assert.deepEqual(run(Character.FOX,1,seq(1,[341,[343,8],341])).result[18],{attempts:2});
assert.deepEqual(run(Character.GAME_AND_WATCH,24,seq(24,[353,[353,30],353,354,[354,20],354])).result[18],{attempts:1});
assert.deepEqual(run(Character.DONKEY_KONG,3,seq(3,[369,[370,8],370,[375,8],375,378])).result[18],full(1));
assert.deepEqual(run(Character.DONKEY_KONG,3,seq(3,[373,14,378])).result[18],full(2));
assert.deepEqual(run(Character.SAMUS,13,seq(13,[343,[344,30],344,345,346,347,348])).result[18],{attempts:1});
assert.deepEqual(run(Character.SHEIK,7,seq(7,[341,[342,30],342,345,346,348])).result[18],{attempts:1});
assert.deepEqual(run(Character.YOUNG_LINK,20,seq(20,[[347,1.3300000429153442],[347,2.6600000858306885],348,349])).result[18],{attempts:1},"Young Link bow's first post frame uses its 1.33x animation rate");
assert.equal(run(Character.YOUNG_LINK,20,seq(20,[[347,2.6600000858306885]])).result[18],null,"joining an advanced bow startup remains unavailable");
for(const [external,internal,rate] of [[Character.LINK,6,1],[Character.YOUNG_LINK,20,1.33]]) {
  const bow=[[post(internal,50,49,{isAirborne:false})],[post(internal,347,rate*2,{isAirborne:true})],[post(internal,347,rate*3,{isAirborne:true})]];
  assert.deepEqual(run(external,internal,bow).result[18],{attempts:1},"same-frame bow ground-to-air collision advances the initial animation twice");
  assert.equal(run(external,internal,[[post(internal,347,rate*2,{isAirborne:true})]]).result[18],null,"counter alone never proves a ground-to-air initiation");
  assert.equal(run(external,internal,[[post(internal,50,49,{isAirborne:false})],[post(internal,347,rate*3,{isAirborne:true})]]).result[18],null,"a later bow phase remains unavailable");
}
assert.deepEqual(run(Character.MARTH,18,seq(18,[341,[342,30],342,343,344])).result[18],full(1));
assert.deepEqual(run(Character.JIGGLYPUFF,15,seq(15,[346,347,[348,30],348,349,350,351,352,353,354,355,356,357,358,359,360,361,362])).result[18],full(1));
assert.deepEqual(run(Character.MEWTWO,16,seq(16,[341,[342,30],342,343,344,345])).result[18],{attempts:1});

// Passive catches and parasol reopens do not manufacture new initiations or
// erase valid coverage. Item parasol states can be entered without an Up B.
for(const [external,internal] of [[Character.LINK,6],[Character.YOUNG_LINK,20]]) {
  assert.deepEqual(run(external,internal,seq(internal,[351,354])).result[19],{attempts:0});
  assert.deepEqual(run(external,internal,seq(internal,[350,14,351,352,14,354,355])).result[19],{attempts:3});
}
assert.deepEqual(run(Character.PEACH,9,seq(9,[369,370,361,362,369,370])).result[20],{attempts:1});
assert.deepEqual(run(Character.LUIGI,17,seq(17,[343,[344,30],344,345,346,347,348,349,350,351,352,353,354])).result[19],full(1));
assert.deepEqual(run(Character.MARTH,18,seq(18,Array.from({length:18},(_,i)=>349+i))).result[19],full(1));
assert.deepEqual(run(Character.PIKACHU,12,seq(12,[353,354,[354,12],354,355,356,357,358])).result[20],full(1));
assert.deepEqual(run(Character.YOSHI,14,seq(14,[360,356,357,358,359,361,362,363])).result[19],full(1));
assert.deepEqual(run(Character.YOSHI,14,seq(14,[[27,15],[356,1],[356,2],357,358,359])).result[19],full(1),"same-frame Egg Roll landing may expose ground startup first");
assert.equal(run(Character.YOSHI,14,seq(14,[[356,4]])).result[19],null,"joining advanced grounded Egg Roll remains unavailable");
assert.deepEqual(run(Character.ICE_CLIMBERS,11,seq(11,[347,348,349,350,351,352,353,354,355,356])).result[20],{attempts:1});

// Damage evidence, shield/no-hit semantics, trade on exit, and missing data.
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0,{lastAttackLanded:20}),post(18,181,0,{shieldSize:40})]]).result[20],full(1));
for(const [external,internal] of [[Character.FOX,1],[Character.FALCO,22]]) {
  assert.deepEqual(run(external,internal,[[post(internal,350,0,{instanceId:375})],[post(internal,351,3,{instanceId:375})],
    [post(internal,352,0,{instanceId:375,lastAttackLanded:19}),post(18,75,0,{percent:7,lastHitBy:0,instanceHitBy:375})]]).result[19],full(1,1),"Side B afterimage inherits the activation's fighter instance through recovery phases");
}
assert.deepEqual(run(Character.SHEIK,7,[[post(7,358,0)],[post(7,359,36,{instanceId:475,lastAttackLanded:20}),post(18,75,0,{percent:12,lastHitBy:0,instanceHitBy:475})]]).result[20],{attempts:1},"Vanish item explosions have no reliable per-use no-hit denominator");
assert.deepEqual(run(Character.PEACH,9,[[post(9,357,0)],[post(9,359,1,{instanceId:50,lastAttackLanded:19}),post(18,75,0,{percent:16,lastHitBy:0,instanceHitBy:50})]]).result[19],{attempts:1},"Bomber item explosions have no reliable per-use no-hit denominator");
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0,{instanceId:4})],[post(0,75,0,{instanceId:5,lastAttackLanded:20}),post(18,75,0,{percent:3,lastHitBy:0,instanceHitBy:4})]]).result[20],full(1,1));
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0,{instanceId:4,lastAttackLanded:20}),post(18,75,0,{percent:3,lastHitBy:0,instanceHitBy:9})]]).result[20],full(1));
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0,{lastAttackLanded:20}),post(18,359,0,{percent:3,lastHitBy:0})]]).result[20],full(1));
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0)],[post(0,75,0)]]).result[20],full(1));
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0)],[post(0,347,9)],[post(0,347,0)]]).result[20],full(2));
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0)],[post(0,348,0)]]).result[20],full(1));
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0)],[post(0,347,0)],[post(0,347,0)]]).result[20],full(1));
assert.deepEqual(run(Character.MARIO,0,[[post(0,347,0) ,post(18,14,0,{percent:undefined})]]).result[20],{attempts:1});
assert.equal(run(Character.FOX,1,seq(1,[342])).result[18],null);
assert.equal(run(Character.FOX,1,seq(1,[[341,20]])).result[18],null);
assert.equal(run(Character.FOX,1,[[post(1,341,0,{actionStateCounter:undefined})]]).result[18],null);
for(const first of [0,1000]) for(const sequence of [[],seq(1,[341])]) {
  const result=run(Character.FOX,1,sequence,{first}).result;
  for(const moveId of SPECIAL_MOVE_IDS) assert.equal(result[moveId],null);
}
const gap=run(Character.FOX,1,[],{close:false});
addSpecialMovesFrame(gap.acc,{frame:-120,players:{0:{post:post(1)},1:{post:post(18)}}});
for(const moveId of SPECIAL_MOVE_IDS) assert.equal(finishSpecialMovesAccumulator(gap.acc).get(0)[moveId],null);
// Complete prefixes and measured zeros must not survive a declared missing tail.
for(const sequence of [[],seq(1,[341,14,347,14,353,14,360,14])]) {
  const sample=run(Character.FOX,1,sequence);
  const last=sample.acc.previousFrame;
  const accepted=finishSpecialMovesAccumulator(sample.acc,{expectedLastFrame:last,finalizedLastFrame:last});
  assert.deepEqual(accepted.get(0),sample.result);
  for(const bounds of [
    {expectedLastFrame:last+10,finalizedLastFrame:last},
    {expectedLastFrame:last,finalizedLastFrame:last-1},
    {expectedLastFrame:last,finalizedLastFrame:last+20},
    {expectedLastFrame:last+10,finalizedLastFrame:last+10},
    {expectedLastFrame:last,finalizedLastFrame:null},
    {expectedLastFrame:NaN,finalizedLastFrame:last},
  ]) for(const moves of finishSpecialMovesAccumulator(sample.acc,bounds).values()) {
    for(const moveId of SPECIAL_MOVE_IDS) assert.equal(moves[moveId],null,"partial, rewound or unobserved terminal frame invalidates every direction, including Down B");
  }
}
const missingTerminal=run(Character.FOX,1,[],{close:false});
addSpecialMovesFrame(missingTerminal.acc,{frame:-122,players:{0:{post:post(1)}}});
const missingFinalCounts=finishSpecialMovesAccumulator(missingTerminal.acc,{expectedLastFrame:-122,finalizedLastFrame:-122});
for(const moveId of SPECIAL_MOVE_IDS) assert.equal(missingFinalCounts.get(1)[moveId],null,"missing own terminal post removes attempts");
assert.deepEqual(missingFinalCounts.get(0)[19],{attempts:0},"missing opponent terminal evidence removes outcomes, preserving independently observed own attempts");
const missingPlayers=run(Character.FOX,1,[],{close:false});
addSpecialMovesFrame(missingPlayers.acc,{frame:-122});
for(const moves of finishSpecialMovesAccumulator(missingPlayers.acc,{expectedLastFrame:-122,finalizedLastFrame:-122}).values()) {
  for(const moveId of SPECIAL_MOVE_IDS) assert.equal(moves[moveId],null,"item-only frame with missing players is unavailable rather than a parse exception");
}
const copied=run(Character.KIRBY,4,seq(4,[399]));
assert.equal(copied.result[18],null);
assert.deepEqual(copied.result[19],full(0));
assert.deepEqual(copied.result[20],{attempts:0});
const transformed=run(Character.SHEIK,7,[[post(7,361,0)],[post(19,356,1)],[post(19,14)]],{close:false}).result;
for(const moveId of [18,19,20]) assert.equal(transformed[moveId],null);
assert.deepEqual(transformed[21],{attempts:1});
const wrong=run(Character.FOX,1,[[post(0)]]).result;
for(const moveId of SPECIAL_MOVE_IDS) assert.equal(wrong[moveId],null);
const bounded=run(Character.FOX,1,[],{close:false});
for(let i=0;i<10000;i++) bounded.feed(post(1));
assert.equal(bounded.acc.players.length,2);
assert.equal(Object.keys(bounded.acc.players[0].previous).length,7);
assert.equal(Object.keys(bounded.acc.players[0].moves).length,3);
assert.deepEqual(finishSpecialMovesAccumulator(bounded.acc),finishSpecialMovesAccumulator(bounded.acc));
console.log("Special checks passed: all 26 characters × 4 directions, coverage, phases, charge/fire loops, captures, transformations, damage attribution, and bounded memory.");
