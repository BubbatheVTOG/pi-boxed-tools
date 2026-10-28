// Unit tests for pi-boxed-tools (boxed renderers for pi's text tools).
// Loads the real module through pi's own jiti pipeline; verifies the renderer
// resolver contract and every render state (no LLM, no network, no files).
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Installed pi package root: PI_PACKAGE_DIR, else resolved from the global npm root.
const PKG =
  process.env.PI_PACKAGE_DIR ??
  path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const { createJiti } = await import(
  pathToFileURL(path.join(PKG, "node_modules/jiti/lib/jiti-static.mjs")).href
);
const alias = {
  "@earendil-works/pi-coding-agent": path.join(PKG, "dist/index.js"),
  "@earendil-works/pi-tui": path.join(PKG, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  typebox: path.join(PKG, "node_modules/typebox/build/index.mjs"),
};

// keyHint reads pi's global theme, which pi initializes before any render.
const pi = await import(pathToFileURL(alias["@earendil-works/pi-coding-agent"]).href);
pi.initTheme("dark");
// The same pi-tui instance the extension resolves through the alias; used to
// pin terminal capabilities so image tests do not depend on the host terminal.
const tui = await import(pathToFileURL(alias["@earendil-works/pi-tui"]).href);

const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const factory = await jiti.import(path.join(ROOT, "src/index.ts"), {
  default: true,
});
if (typeof factory !== "function") {
  console.error("FATAL: pi-boxed-tools default export is not a function");
  process.exit(1);
}
console.log("LOAD OK — pi-boxed-tools factory is a function");

const resolvers = [];
const registeredTools = [];
factory({
  registerToolRenderer: (resolver) => resolvers.push(resolver),
  registerTool: (tool) => registeredTools.push(tool),
});

const NAMES = ["read", "grep", "find", "ls", "bash"];
let failures = 0;
// outcome: a boolean, or { ok, detail } when a failure needs diagnostics.
const check = (label, outcome) => {
  const { ok, detail = "" } = typeof outcome === "object" ? outcome : { ok: outcome };
  if (ok) {
    console.log(`OK  ${label}`);
    return;
  }
  failures++;
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
};

check("display-only → one renderer resolver, no tool overrides", {
  ok: resolvers.length === 1 && registeredTools.length === 0,
  detail: JSON.stringify({ resolvers: resolvers.length, tools: registeredTools.length }),
});
const resolve = resolvers[0];
const NEXT = { renderShell: "default" };
const tools = NAMES.map((name) => ({ name, ...resolve(name, () => NEXT) }));
for (const t of tools) {
  check(
    `${t.name} → self-shell boxed renderers`,
    t.renderShell === "self" &&
      typeof t.renderCall === "function" &&
      typeof t.renderResult === "function",
  );
}
check("unowned tools (edit, write, web_search) → defer to next()", {
  ok: ["edit", "write", "web_search"].every((name) => resolve(name, () => NEXT) === NEXT),
});

const theme = {
  fg: (c, s) => (c === "error" ? `[err]${s}[/err]` : s),
  bold: (s) => s,
};
const WIDTH = 90;
const visible = (s) => s.replace(/\u001b\[[0-9;:]*m/g, "");

// renderCall: slim header
const rc = tools
  .find((t) => t.name === "read")
  .renderCall({ path: "/tmp/x.ts", offset: 5, limit: 20 }, theme);
const rcLines = rc.render(WIDTH);
check("read renderCall → one-line header with path + offset", {
  ok:
    rcLines.length === 1 &&
    rcLines[0].includes("read") &&
    rcLines[0].includes("/tmp/x.ts") &&
    rcLines[0].includes("from 5"),
  detail: JSON.stringify(rcLines),
});

const ansiTheme = {
  fg: (_c, s) => `\u001b[36m${s}\u001b[39m`,
  bold: (s) => s,
};
const longHdr = tools
  .find((t) => t.name === "read")
  .renderCall({ path: "/a/very/long/path/".repeat(10) }, ansiTheme)
  .render(40)[0];
check("renderCall header → cut by visible width, colors closed", {
  ok:
    visible(longHdr).length === 40 &&
    visible(longHdr).endsWith("…") &&
    !/\u001b\[[0-9;]*$/.test(longHdr),
  detail: JSON.stringify(longHdr),
});

// bash renderCall: shell syntax highlighting + multiline preservation
const bash = tools.find((t) => t.name === "bash");
const bashCall = bash
  .renderCall({ command: "git status --short && npm test -- --runInBand" }, theme)
  .render(WIDTH)
  .map(visible);
check("bash renderCall → command header with complete command", {
  ok:
    bashCall.length === 1 &&
    bashCall[0].includes("bash") &&
    bashCall[0].includes("git status") &&
    bashCall[0].includes("npm test"),
  detail: JSON.stringify(bashCall),
});
const multilineCall = bash
  .renderCall({ command: "if true; then\n  echo ready\nfi" }, theme)
  .render(WIDTH)
  .map(visible);
check("bash renderCall → multiline shell command collapses to one row", {
  ok:
    multilineCall.length === 1 &&
    multilineCall[0].includes("if true; then") &&
    multilineCall[0].includes("+2 lines") &&
    !multilineCall[0].includes("echo ready"),
  detail: JSON.stringify(multilineCall),
});

// renderResult states (use bash tool as representative)
const body = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
const collapsed = bash
  .renderResult(
    { content: [{ type: "text", text: body }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
check("bash collapsed → framed with success marker", {
  ok:
    collapsed[0].startsWith("╭") &&
    collapsed[0].includes("✓ bash") &&
    collapsed.at(-1).startsWith("╰"),
  detail: JSON.stringify(collapsed[0]),
});
check("bash collapsed → newest 8 lines + earlier-lines hint", {
  ok:
    collapsed.some((l) => l.includes("output line 30")) &&
    collapsed.some((l) => l.includes("output line 23")) &&
    !collapsed.some((l) => l.includes("output line 22 ")) &&
    collapsed.some((l) => l.includes("22 earlier lines")),
  detail: JSON.stringify(collapsed),
});
const readCollapsed = tools
  .find((t) => t.name === "read")
  .renderResult(
    { content: [{ type: "text", text: body }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
check("read collapsed → first 8 lines + more-lines hint, no success marker", {
  ok:
    readCollapsed.some((l) => l.includes("output line 8")) &&
    !readCollapsed.some((l) => l.includes("output line 9")) &&
    readCollapsed.some((l) => l.includes("+22 more lines")) &&
    !readCollapsed[0].includes("✓"),
  detail: JSON.stringify(readCollapsed),
});
const truncatedBody = `${body}\n\n[Showing lines 1-30 of 90. Full output: /tmp/pi-bash-x.log]`;
const truncated = bash
  .renderResult(
    { content: [{ type: "text", text: truncatedBody }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
check("bash collapsed truncated → full-output footer stays visible", {
  ok: truncated.some((l) => l.includes("Full output: /tmp/pi-bash-x.log")),
  detail: JSON.stringify(truncated),
});
const expanded = bash
  .renderResult(
    { content: [{ type: "text", text: body }] },
    { expanded: true, isPartial: false },
    theme,
  )
  .render(WIDTH);
check(
  "bash expanded → full content",
  expanded.some((l) => l.includes("output line 30")),
);
const partial = bash
  .renderResult({ content: [] }, { expanded: false, isPartial: true }, theme)
  .render(WIDTH);
check(
  "bash isPartial → running marker and running… inside frame",
  partial[0].includes("⋯ bash") && partial.some((l) => l.includes("running…")),
);
const partialExpanded = bash
  .renderResult({ content: [] }, { expanded: true, isPartial: true }, theme, {
    args: { command: "while true; do\n  echo tick\ndone" },
  })
  .render(WIDTH)
  .map(visible);
check("bash isPartial expanded → full command shown while running", {
  ok:
    partialExpanded.some((l) => l.includes("echo tick")) &&
    partialExpanded.some((l) => l.includes("running…")),
  detail: JSON.stringify(partialExpanded),
});
const streamed = Array.from({ length: 20 }, (_, i) => `tick ${i + 1}`).join("\n");
const partialTail = bash
  .renderResult(
    { content: [{ type: "text", text: streamed }] },
    { expanded: false, isPartial: true },
    theme,
  )
  .render(WIDTH);
check("bash isPartial collapsed → streams the newest lines with earlier-lines hint", {
  ok:
    partialTail.some((l) => l.includes("tick 20")) &&
    !partialTail.some((l) => l.includes("tick 12 ")) &&
    partialTail.some((l) => l.includes("12 earlier lines")) &&
    partialTail.some((l) => l.includes("running…")),
  detail: JSON.stringify(partialTail),
});
const newlineEnded = Array.from({ length: 12 }, (_, i) => `n${i + 1}`).join("\n") + "\n";
const fullTail = bash
  .renderResult(
    { content: [{ type: "text", text: newlineEnded }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
const runningTail = bash
  .renderResult(
    { content: [{ type: "text", text: newlineEnded }] },
    { expanded: false, isPartial: true },
    theme,
  )
  .render(WIDTH);
check("trailing newline → tail preview keeps 8 real lines, no blank row", {
  ok:
    fullTail.some((l) => l.includes("n5 ")) &&
    fullTail.some((l) => l.includes("4 earlier lines")) &&
    !runningTail.some((l, i) => /^│\s+│$/.test(visible(l)) && i < runningTail.length - 1),
  detail: JSON.stringify([fullTail, runningTail]),
});
const partialAll = bash
  .renderResult(
    { content: [{ type: "text", text: streamed }] },
    { expanded: true, isPartial: true },
    theme,
  )
  .render(WIDTH);
check(
  "bash isPartial expanded → all streamed lines",
  partialAll.some((l) => l.includes("tick 1 ")) && partialAll.some((l) => l.includes("tick 20")),
);

const dirty = bash
  .renderResult(
    {
      content: [
        { type: "text", text: "a\tb\u0007c\r\nprog 10%\rprog 100%\u001b[2K" },
        { type: "text", text: "second block\u001b]0;title\u0007" },
      ],
    },
    { expanded: true, isPartial: false },
    theme,
  )
  .render(40);
check("output sanitized → no tabs/CR/control/non-SGR escapes, borders aligned", {
  ok:
    dirty.every((l) => !/[\t\r\u0000-\u001a\u001c-\u001f]/.test(l)) &&
    dirty.every((l) => !l.includes("\u001b]") && !l.includes("[2K")) &&
    new Set(dirty.map((l) => visible(l).length)).size === 1,
  detail: JSON.stringify(dirty),
});
check("output sanitized → CR keeps last segment, text blocks on separate lines", {
  ok:
    dirty.some((l) => l.includes("a   bc")) &&
    dirty.some((l) => l.includes("prog 100%")) &&
    !dirty.some((l) => l.includes("prog 10%")) &&
    dirty.some((l) => l.includes("│ second block")),
  detail: JSON.stringify(dirty),
});
const blank = bash
  .renderResult(
    { content: [{ type: "text", text: "\n  \n" }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
check(
  "whitespace-only output → (no output)",
  blank.some((l) => l.includes("(no output)")),
);
const resettingTheme = {
  fg: (_c, s) => `${s}\u001b[0m`,
  bold: (s) => s,
  getBgAnsi: () => "<BG>",
};
const filled = bash
  .renderResult(
    { content: [{ type: "text", text: "xy" }] },
    { expanded: false, isPartial: false },
    resettingTheme,
  )
  .render(WIDTH);
check("background fill re-applied after a full SGR reset in styled text", {
  ok: filled.every((l) => !/\u001b\[0m(?!<BG>)/.test(l.slice(0, -"\u001b[49m".length))),
  detail: JSON.stringify(filled),
});
const colored = bash
  .renderResult(
    { content: [{ type: "text", text: "\u001b[1;31mred\u001b[7m reversed\u009b2J" }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
check("tool-output colors and C1 controls stripped", {
  ok:
    colored.some((l) => l.includes("│ red reversed2J")) &&
    colored.every((l) => !l.includes("\u001b") && !l.includes("\u009b")),
  detail: JSON.stringify(colored),
});
const readTool = tools.find((t) => t.name === "read");
const imageRows = (part, context) =>
  readTool
    .renderResult(
      {
        content: [
          { type: "text", text: "Read image file" },
          { type: "image", ...part },
        ],
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    )
    .render(WIDTH);
const png = { mimeType: "image/png", data: "AAAA" };
const hasNote = (rows) => rows.some((l) => l.includes("image/png"));
tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
check("image pi draws (capable terminal, showImages, data) → no placeholder", {
  ok: !hasNote(imageRows(png, { showImages: true })),
});
check("image with showImages off → placeholder", {
  ok: hasNote(imageRows(png, { showImages: false })),
});
check("image without data → placeholder (pi skips drawing it)", {
  ok: hasNote(imageRows({ mimeType: "image/png" }, { showImages: true })),
});
tui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
check("image on a terminal without image support → placeholder", {
  ok: hasNote(imageRows(png, { showImages: true })),
});
const hostileImage = imageRows({ mimeType: "image/png\n\u001b[2J", data: "AAAA" }, {});
check("image placeholder → hostile mimeType cannot break the row", {
  ok:
    hostileImage.some((l) => l.includes("image/png")) &&
    hostileImage.every((l) => !l.includes("\u001b[2J")) &&
    new Set(hostileImage.map((l) => visible(l).length)).size === 1,
  detail: JSON.stringify(hostileImage),
});
tui.resetCapabilitiesCache();

// No row may exceed the width render() was given, even below the frame minimum.
const narrowBody = { content: [{ type: "text", text: "日本語 wide 👍🏽 text\tand more" }] };
const narrowFits = Array.from({ length: 16 }, (_, i) => i + 1).every((width) => {
  const rows = bash
    .renderResult(narrowBody, { expanded: true, isPartial: false }, theme, {
      args: { command: "echo one\necho two" },
    })
    .render(width);
  const header = bash.renderCall({ command: "echo one\necho two" }, theme).render(width);
  return [...rows, ...header].every((l) => tui.visibleWidth(l) <= width);
});
check("narrow widths 1..16 → every row and header fits the given width", narrowFits);

const errored = bash
  .renderResult(
    { content: [{ type: "text", text: "command failed" }] },
    { expanded: false, isPartial: false },
    theme,
    { isError: true },
  )
  .render(WIDTH);
check(
  "bash isError → failure marker and error-colored content",
  errored[0].includes("✗ bash") &&
    errored.some((l) => l.startsWith("│") && l.includes("[err]command failed")),
);
const empty = bash
  .renderResult(
    { content: [{ type: "text", text: "" }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
check(
  "bash empty → (no output) inside frame",
  empty.some((l) => l.includes("(no output)")),
);

// bash renderCall: multi-line commands collapse to one header row
const multi = "python3 - <<PY\r\nimport x\nprint(1)\nPY";
const multiHdrRaw = bash.renderCall({ command: multi }, theme).render(120);
const multiHdr = multiHdrRaw.map(visible);
check("bash multi-line renderCall → exactly one row, first line + count + hint", {
  ok:
    multiHdr.length === 1 &&
    multiHdr[0].includes("python3 - <<PY") &&
    multiHdr[0].includes("+3 lines") &&
    !multiHdr[0].includes("import x"),
  detail: JSON.stringify(multiHdr),
});
check(
  "bash renderCall → no CR/LF inside any row (CRLF input normalized)",
  !multiHdrRaw.some((l) => /[\r\n]/.test(l)),
);
const multiRes = { content: [{ type: "text", text: "out1\nout2" }] };
const multiCol = bash
  .renderResult(multiRes, { expanded: false }, theme, {
    args: { command: multi },
  })
  .render(100);
const multiExp = bash
  .renderResult(multiRes, { expanded: true }, theme, {
    args: { command: multi },
  })
  .render(100);
check("bash collapsed result → command not shown", !multiCol.some((l) => l.includes("import x")));
check("bash expanded result → full command inside box above output", {
  ok:
    multiExp.some((l) => l.includes("import x")) &&
    multiExp.some((l) => l.includes("out2")) &&
    multiExp.findIndex((l) => l.includes("import x")) <
      multiExp.findIndex((l) => l.includes("out2")),
  detail: JSON.stringify(multiExp),
});
const emptyMultiRes = { content: [{ type: "text", text: "" }] };
const emptyMultiCol = bash
  .renderResult(emptyMultiRes, { expanded: false }, theme, {
    args: { command: multi },
  })
  .render(100);
const emptyMultiExp = bash
  .renderResult(emptyMultiRes, { expanded: true }, theme, {
    args: { command: multi },
  })
  .render(100);
check("bash collapsed empty result → command remains hidden", {
  ok:
    !emptyMultiCol.some((l) => l.includes("import x")) &&
    emptyMultiCol.some((l) => l.includes("(no output)")),
  detail: JSON.stringify(emptyMultiCol),
});
check("bash expanded empty result → full command shown above no-output marker", {
  ok:
    emptyMultiExp.some((l) => l.includes("import x")) &&
    emptyMultiExp.some((l) => l.includes("(no output)")) &&
    emptyMultiExp.findIndex((l) => l.includes("import x")) <
      emptyMultiExp.findIndex((l) => l.includes("(no output)")),
  detail: JSON.stringify(emptyMultiExp),
});
check("bash renderCall → trailing/leading blank lines do not count", {
  ok:
    visible(bash.renderCall({ command: "\n  echo hi\n\n" }, theme).render(80)[0]) ===
    " bash   echo hi",
  detail: JSON.stringify(bash.renderCall({ command: "\n  echo hi\n\n" }, theme).render(80)),
});
const grepHdr = tools
  .find((t) => t.name === "grep")
  .renderCall({ pattern: "a\nb\u001b[2J", path: "src\tx" }, theme)
  .render(80);
check("detail header → newline/escape/tab in args flattened to one clean row", {
  ok: grepHdr.length === 1 && grepHdr[0] === " grep a b in src   x",
  detail: JSON.stringify(grepHdr),
});
check("renderCall tolerates undefined args", {
  ok: tools.every((t) => t.renderCall(undefined, theme).render(80).length === 1),
});
check(
  "bash single-line renderCall → unchanged, no count suffix",
  bash.renderCall({ command: "ls -la" }, theme).render(80)[0] === " bash ls -la",
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
