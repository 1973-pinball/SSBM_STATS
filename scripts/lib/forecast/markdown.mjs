const MARKDOWN_TEXT_ESCAPES = Object.freeze({
  "&": "&amp;",
  "\\": "\\\\",
  "|": "\\|",
  "<": "&lt;",
  ">": "&gt;",
  "\r": " ",
  "\n": " ",
  "\t": " ",
  "\u2028": " ",
  "\u2029": " ",
});

export function markdownText(value) {
  let result = "";
  for (const char of String(value ?? "")) {
    result += MARKDOWN_TEXT_ESCAPES[char] ?? char;
  }
  return result;
}

export function markdownCodeSpan(value) {
  const text = markdownText(value);
  let longestRun = 0;
  let currentRun = 0;
  for (const char of text) {
    if (char === "`") {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  const fence = "`".repeat(longestRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return fence + padding + text + padding + fence;
}
