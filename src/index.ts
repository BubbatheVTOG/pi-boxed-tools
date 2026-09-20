// pi-boxed-tools — boxed tool-call rendering for pi's text tools.
//
// Claims read/grep/find/ls/bash (same-name registration; local extensions
// load before npm packages, and pi-tool-display's per-tool ownership toggles
// hand these over — registerToolOverrides.<tool>: false there). edit/write
// stay with pi-tool-display (diff rendering); its user message box is
// untouched.
//
// Style: the pi-tool-display user-box aesthetic (rounded frame, accent title,
// userMessageBg background fill), adapted from its MIT-licensed renderer.
// Collapsed results show a preview + expand hint; Ctrl+O shows everything.
// Display-only: execute delegates to pi's real built-in tools; parameters,
// description and prompt metadata are copied from the real tools (overrides
// do not inherit prompt metadata — pi docs, "Override built-in tools").
import {
  createBashTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  highlightCode,
  keyHint,
  type ExtensionAPI,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Boxed, type BoxTheme, type BoxStyle } from "./box.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PREVIEW_LINES = 8;
const HEADER_MAX = 120;

interface ToolArgs {
  [k: string]: unknown;
}

interface RenderContext {
  args?: ToolArgs;
  isPartial?: boolean;
  expanded?: boolean;
  isError?: boolean;
}

interface ThemeLike extends BoxTheme {
  fg(color: string, text: string): string;
}

// SAFETY: structural type of pi's ToolDefinition as produced by the built-in
// create*Tool factories; we copy its public metadata fields verbatim and
// delegate execute with its own argument order.
interface BuiltInTool {
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  parameters?: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { cwd: string },
  ): Promise<unknown>;
}

type CreateTool = (cwd: string) => BuiltInTool;

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "Ctrl+O to expand";
  }
}

function argSuffix(args: ToolArgs, keys: string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (v === undefined) continue;
    parts.push(typeof v === "string" ? v : String(v));
  }
  const joined = parts.join(" ");
  return joined ? ` ${joined}` : "";
}

function header(theme: ThemeLike, name: string, detail: string): string {
  const title = theme.fg("toolTitle", `${name} `);
  const rest = theme.fg("muted", truncateToWidth(detail, HEADER_MAX, "…"));
  return ` ${title}${rest}`;
}

// pi-tui requires one string per row with no line terminators; CRLF input
// would otherwise leave a stray \r in the row and corrupt redraws.
function commandLines(command: string): string[] {
  return highlightCode(command.replace(/\r\n?/g, "\n"), "bash");
}

// The call header is always one row: first command line plus a line count.
// The full command is shown inside the result box when expanded, so long
// heredocs never flood the transcript outside the frame.
function bashCallLines(
  theme: ThemeLike,
  command: string,
  width: number,
): string[] {
  const title = theme.fg("toolTitle", "bash ");
  const lines = commandLines(command);
  const extra = lines.length - 1;
  const suffix =
    extra > 0 ? theme.fg("dim", ` (+${extra} lines · ${expandHint()})`) : "";
  const prefix = ` ${title}`;
  const budget = Math.max(
    0,
    width - visibleWidth(prefix) - visibleWidth(suffix),
  );
  return [`${prefix}${truncateToWidth(lines[0] ?? "", budget, "…")}${suffix}`];
}

function resultLines(result: unknown): string[] {
  const r = result as
    | {
        content?: Array<{ type?: string; text?: string }>;
        details?: { error?: unknown };
      }
    | undefined;
  const parts = Array.isArray(r?.content)
    ? (r?.content as Array<{ type?: string; text?: string }>)
    : [];
  const text = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
  const lines = text.split("\n");
  const err = r?.details?.error;
  if (err !== undefined && err !== null) {
    return [String(err), ...lines];
  }
  return lines;
}

function boxedResult(
  result: unknown,
  options: ToolRenderResultOptions,
  theme: ThemeLike,
  style: BoxStyle,
  context?: RenderContext,
  toolName?: string,
): Boxed {
  const expanded = options.expanded === true;
  const isBash = toolName === "bash";
  const status = options.isPartial
    ? { marker: "⋯", color: "warning" }
    : context?.isError
      ? { marker: "✗", color: "error" }
      : isBash
        ? { marker: "✓", color: "success" }
        : undefined;
  const displayStyle = status
    ? {
        ...style,
        title: ` ${status.marker}${style.title}`,
        titleColor: status.color,
      }
    : style;

  return new Boxed(() => {
    if (options.isPartial) {
      return { lines: [theme.fg("warning", "running…")], style: displayStyle };
    }
    const raw = resultLines(result);
    const isEmpty = raw.length === 1 && raw[0].trim() === "";
    const colored = context?.isError
      ? raw.map((l) => theme.fg("error", l))
      : raw;
    if (expanded) {
      const command = String(context?.args?.command ?? "");
      const highlightedCommand = isBash ? commandLines(command) : [];
      const commandBlock =
        highlightedCommand.length > 1
          ? [...highlightedCommand, theme.fg("dim", "─".repeat(24))]
          : [];
      const output = isEmpty ? [theme.fg("muted", "(no output)")] : colored;
      return { lines: [...commandBlock, ...output], style: displayStyle };
    }
    if (isEmpty) {
      return { lines: [theme.fg("muted", "(no output)")], style: displayStyle };
    }
    if (colored.length <= PREVIEW_LINES) {
      return { lines: colored, style: displayStyle };
    }
    const hidden = colored.length - PREVIEW_LINES;
    return {
      lines: [
        ...colored.slice(0, PREVIEW_LINES),
        theme.fg("dim", `… +${hidden} more lines · ${expandHint()}`),
      ],
      style: displayStyle,
    };
  }, theme);
}

export default function (pi: ExtensionAPI): void {
  const tools = new Map<string, BuiltInTool>();
  const get = (cwd: string, name: string, create: CreateTool): BuiltInTool => {
    const key = `${cwd}\u0000${name}`;
    let t = tools.get(key);
    if (!t) {
      t = create(cwd);
      tools.set(key, t);
    }
    return t;
  };

  const makeTool = (
    name: string,
    headerDetail: (args: ToolArgs) => string,
    create: CreateTool,
  ) => {
    // One real instance for prompt metadata + parameter schema (these do not
    // vary by cwd). pi reads parameters.properties when binding the tool —
    // the override must carry the real tool's typebox schema verbatim.
    const real = create(process.cwd());
    return {
      name,
      label: name,
      description: real.description,
      promptSnippet: real.promptSnippet,
      promptGuidelines: real.promptGuidelines,
      parameters: real.parameters,
      renderShell: "self" as const,
      renderCall(args: ToolArgs, theme: ThemeLike) {
        let cached: string[] = [];
        return {
          render: (width: number) => {
            cached =
              name === "bash"
                ? bashCallLines(theme, String(args.command ?? ""), width)
                : [
                    header(theme, name, headerDetail(args)).slice(
                      0,
                      Math.max(0, width),
                    ),
                  ];
            return cached;
          },
          invalidate: () => {
            cached = [];
          },
        };
      },
      renderResult(
        result: unknown,
        options: ToolRenderResultOptions,
        theme: ThemeLike,
        context?: RenderContext,
      ) {
        return boxedResult(
          result,
          options,
          theme,
          { title: ` ${name} ` },
          context,
          name,
        );
      },
      execute(
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: { cwd: string },
      ) {
        const cwd = ctx?.cwd ?? process.cwd();
        return get(cwd, name, create).execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    };
  };

  pi.registerTool(
    makeTool(
      "read",
      (a) =>
        argSuffix(a, ["path"]) +
        (a.offset === undefined ? "" : ` from ${String(a.offset)}`) +
        (a.limit === undefined ? "" : ` (${String(a.limit)} lines)`),
      (cwd) => createReadTool(cwd) as BuiltInTool,
    ),
  );
  pi.registerTool(
    makeTool(
      "grep",
      (a) =>
        argSuffix(a, ["pattern"]) +
        (a.path ? ` in ${String(a.path)}` : "") +
        (a.glob ? ` (${String(a.glob)})` : ""),
      (cwd) => createGrepTool(cwd) as BuiltInTool,
    ),
  );
  pi.registerTool(
    makeTool(
      "find",
      (a) =>
        argSuffix(a, ["pattern"]) + (a.path ? ` in ${String(a.path)}` : ""),
      (cwd) => createFindTool(cwd) as BuiltInTool,
    ),
  );
  pi.registerTool(
    makeTool(
      "ls",
      (a) => argSuffix(a, ["path"]),
      (cwd) => createLsTool(cwd) as BuiltInTool,
    ),
  );
  pi.registerTool(
    makeTool(
      "bash",
      (a) => argSuffix(a, ["command"]),
      (cwd) => createBashTool(cwd) as BuiltInTool,
    ),
  );
}
