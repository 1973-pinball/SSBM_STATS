/** bsdtar's -T entries are patterns, and Windows bsdtar uses its native code page. */
export function archiveMemberList(names, encoding = "utf-8") {
  const patterns = names.map(name => {
    if (typeof name !== "string" || ["\0", "\r", "\n"].some(char => name.includes(char))) throw new Error("Invalid archive member name");
    // A bracket in a real filename (for example [BF]) must match literally.
    return name.replace(/([*?[\]\\])/g, "\\$1");
  }).join("\n") + "\n";
  if (encoding === "utf-8") return Buffer.from(patterns, "utf8");
  if (encoding !== "windows-1252") throw new Error("Unsupported tar filename encoding");
  const decoder = new TextDecoder(encoding);
  const bytes = new Map(Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte]));
  return Buffer.from([...patterns].map(char => {
    if (!bytes.has(char)) throw new Error("An archive member cannot be represented in the configured tar code page");
    return bytes.get(char);
  }));
}
