// Unit tests for pi-boxed-tools (boxed renderers for pi's text tools).
// Loads the real module through pi's own jiti pipeline; verifies registration,
// prompt-metadata copying, every render state, and real execute delegation
// against a temp workspace (no LLM, no network).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  "@earendil-works/pi-tui": path.join(
    PKG,
    "node_modules/@earendil-works/pi-tui/dist/index.js",
  ),
  typebox: path.join(PKG, "node_modules/typebox/build/index.mjs"),
};

const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const factory = await jiti.import(path.join(ROOT, "src/index.ts"), {
  default: true,
});
if (typeof factory !== "function") {
  console.error("FATAL: pi-boxed-tools default export is not a function");
  process.exit(1);
}
console.log("LOAD OK — pi-boxed-tools factory is a function");

const tools = [];
factory({ registerTool: (t) => tools.push(t) });

const NAMES = ["read", "grep", "find", "ls", "bash"];
let failures = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`OK  ${label}`);
  else {
    failures++;
    console.error(`FAIL ${label}${extra ? `: ${extra}` : ""}`);
  }
};

for (const name of NAMES) {
  const t = tools.find((x) => x.name === name);
  check(
    `${name} registered with render slots`,
    !!t &&
      typeof t.renderCall === "function" &&
      typeof t.renderResult === "function" &&
      typeof t.execute === "function",
  );
  check(
    `${name} description copied from real tool`,
    typeof t?.description === "string" && t.description.length > 10,
    JSON.stringify(t?.description?.slice(0, 40)),
  );
}

const theme = {
  fg: (c, s) => (c === "error" ? `[err]${s}[/err]` : s),
  bold: (s) => s,
};
const WIDTH = 90;

// renderCall: slim header
const rc = tools
  .find((t) => t.name === "read")
  .renderCall({ path: "/tmp/x.ts", offset: 5, limit: 20 }, theme);
const rcLines = rc.render(WIDTH);
check(
  "read renderCall → one-line header with path + offset",
  rcLines.length === 1 &&
    rcLines[0].includes("read") &&
    rcLines[0].includes("/tmp/x.ts") &&
    rcLines[0].includes("from 5"),
  JSON.stringify(rcLines),
);

// bash renderCall: shell syntax highlighting + multiline preservation
const bash = tools.find((t) => t.name === "bash");
const bashCall = bash
  .renderCall(
    { command: "git status --short && npm test -- --runInBand" },
    theme,
  )
  .render(WIDTH);
check(
  "bash renderCall → command header with complete command",
  bashCall.length === 1 &&
    bashCall[0].includes("bash") &&
    bashCall[0].includes("git status") &&
    bashCall[0].includes("npm test"),
  JSON.stringify(bashCall),
);
const multilineCall = bash
  .renderCall({ command: "if true; then\n  echo ready\nfi" }, theme)
  .render(WIDTH);
check(
  "bash renderCall → multiline shell command collapses to one row",
  multilineCall.length === 1 &&
    multilineCall[0].includes("if true; then") &&
    multilineCall[0].includes("+2 lines") &&
    !multilineCall[0].includes("echo ready"),
  JSON.stringify(multilineCall),
);

// renderResult states (use bash tool as representative)
const body = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join(
  "\n",
);
const collapsed = bash
  .renderResult(
    { content: [{ type: "text", text: body }] },
    { expanded: false, isPartial: false },
    theme,
  )
  .render(WIDTH);
check(
  "bash collapsed → framed with success marker",
  collapsed[0].startsWith("╭") &&
    collapsed[0].includes("✓ bash") &&
    collapsed.at(-1).startsWith("╰"),
  JSON.stringify(collapsed[0]),
);
check(
  "bash collapsed → 8 preview lines + hint",
  collapsed.some((l) => l.includes("output line 8")) &&
    !collapsed.some((l) => l.includes("output line 9")) &&
    collapsed.some((l) => l.includes("+22 more lines")),
);
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
const multiHdr = bash.renderCall({ command: multi }, theme).render(120);
check(
  "bash multi-line renderCall → exactly one row, first line + count + hint",
  multiHdr.length === 1 &&
    multiHdr[0].includes("python3 - <<PY") &&
    multiHdr[0].includes("+3 lines") &&
    !multiHdr[0].includes("import x"),
  JSON.stringify(multiHdr),
);
check(
  "bash renderCall → no CR/LF inside any row (CRLF input normalized)",
  !multiHdr.some((l) => /[\r\n]/.test(l)),
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
check(
  "bash collapsed result → command not shown",
  !multiCol.some((l) => l.includes("import x")),
);
check(
  "bash expanded result → full command inside box above output",
  multiExp.some((l) => l.includes("import x")) &&
    multiExp.some((l) => l.includes("out2")) &&
    multiExp.findIndex((l) => l.includes("import x")) <
      multiExp.findIndex((l) => l.includes("out2")),
  JSON.stringify(multiExp),
);
check(
  "bash single-line renderCall → unchanged, no count suffix",
  bash.renderCall({ command: "ls -la" }, theme).render(80)[0] ===
    " bash ls -la",
);

// ── real execute delegation against a temp workspace ──
const work = "/tmp/pi-boxed-tools-test";
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(
  path.join(work, "sample.txt"),
  "alpha beta\ngamma delta\nalpha again\n",
);
const ctx = {
  cwd: work,
  // stub of pi's session context: the real bash tool reads the session id
  // (and optional file) to inject PI_SESSION_* env vars into child processes
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
};
const run = async (name, params) => {
  const out = await tools
    .find((t) => t.name === name)
    .execute(`t-${name}`, params, undefined, undefined, ctx);
  return (out?.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
};

check(
  "execute read → real file content",
  (await run("read", { path: path.join(work, "sample.txt") })).includes(
    "gamma delta",
  ),
);
check(
  "execute bash → real command output",
  (await run("bash", { command: "echo hello-toolbox" })).includes(
    "hello-toolbox",
  ),
);
check(
  "execute grep → matches file",
  (await run("grep", { pattern: "alpha", path: work })).includes("alpha"),
);
check(
  "execute find → finds sample",
  (await run("find", { pattern: "sample*", path: work })).includes(
    "sample.txt",
  ),
);
check(
  "execute ls → lists workspace",
  (await run("ls", { path: work })).includes("sample.txt"),
);
rmSync(work, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
