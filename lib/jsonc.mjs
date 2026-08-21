/** Minimal JSONC handling for editing Zed's settings.json.
 *
 *  settings.json is JSONC: comments and trailing commas are legal. Parsing it
 *  and re-serialising would silently drop the user's comments and formatting,
 *  so edits are made on the text and a parse is used only as a check.
 *
 *  Everything here is string- and comment-aware, so a `//` inside a URL or a
 *  comma inside a string is never mistaken for syntax.
 */

const BACKSLASH = 92;

/** Advance past whitespace and comments starting at `i`. */
function skipTrivia(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
    } else {
      return i;
    }
  }
}

/** Index just past the closing quote of the string starting at `i`. */
function endOfString(text, i) {
  i += 1; // opening quote
  while (i < text.length) {
    if (text.charCodeAt(i) === BACKSLASH) {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i += 1;
  }
  return i;
}

/** Strip comments and trailing commas so the result can be handed to
 *  JSON.parse. */
export function toStrictJson(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipTrivia(text, i);
      continue;
    }
    if (c === ",") {
      const next = text[skipTrivia(text, i + 1)];
      if (next === "}" || next === "]") {
        i += 1; // trailing comma
        continue;
      }
    }

    out += c;
    i += 1;
  }
  return out;
}

/** Indentation of the line containing `index`. */
function lineIndent(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  return /^[ \t]*/.exec(text.slice(start, index))[0];
}

/** Locate a key in the root object.
 *
 *  Returns `{ at, indent }` where `at` is the index just past the `{` that opens
 *  the key's object value. Depth-aware, so a nested key of the same name is not
 *  mistaken for the real one. Returns `{ rootAt }` instead when the root object
 *  exists but has no such key, or null when there is no root object at all.
 */
function findInRoot(text, key) {
  const quoted = JSON.stringify(key);
  let i = 0;
  let depth = 0;
  let rootAt = null;

  while (i < text.length) {
    i = skipTrivia(text, i);
    if (i >= text.length) break;
    const c = text[i];

    if (c === "{" || c === "[") {
      depth += 1;
      if (depth === 1 && c === "{" && rootAt === null) rootAt = i + 1;
      i += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (c === '"') {
      const end = endOfString(text, i);
      if (depth === 1 && text.slice(i, end) === quoted) {
        let j = skipTrivia(text, end);
        if (text[j] === ":") {
          j = skipTrivia(text, j + 1);
          if (text[j] === "{") return { at: j + 1, indent: lineIndent(text, i) };
        }
      }
      i = end;
      continue;
    }
    i += 1;
  }

  return rootAt === null ? null : { rootAt };
}

/** Indent every non-empty line of a block. */
function indentBlock(block, indent) {
  return block
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

/** Insert `block` (a `"name": {...}` fragment) into the root "agent_servers"
 *  object, creating that object if it is missing. */
export function insertAgentServer(text, block) {
  const found = findInRoot(text, "agent_servers");
  if (!found) throw new Error("settings.json has no top-level object");

  if (found.at !== undefined) {
    const body = indentBlock(block, `${found.indent}  `);
    return `${text.slice(0, found.at)}\n${body},${text.slice(found.at)}`;
  }

  const body = indentBlock(block, "    ");
  return `${text.slice(0, found.rootAt)}\n  "agent_servers": {\n${body}\n  },${text.slice(found.rootAt)}`;
}
