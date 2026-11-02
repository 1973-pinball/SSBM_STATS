import assert from "node:assert/strict";
import { archiveMemberList } from "./lib/interaction-archive-paths.mjs";

const names = ["[event]/Fox [BF].slp", "set/Pokémon Stadium.slp", "literal*question?.slp"];
const expected = "\\[event\\]/Fox \\[BF\\].slp\nset/Pokémon Stadium.slp\nliteral\\*question\\?.slp\n";
assert.equal(archiveMemberList(names).toString("utf8"), expected);
const native = archiveMemberList(names, "windows-1252");
assert.equal(new TextDecoder("windows-1252").decode(native), expected);
assert.ok(native.includes(0xe9), "native Windows accented path bytes survive without UTF-8 replacement");
assert.throws(() => archiveMemberList(["bad\nname.slp"]));
assert.throws(() => archiveMemberList(["bad\0name.slp"]));
assert.throws(() => archiveMemberList(["unrepresentable-雪.slp"], "windows-1252"));
console.log("Archive member lists preserve accents and escape literal pattern characters.");
