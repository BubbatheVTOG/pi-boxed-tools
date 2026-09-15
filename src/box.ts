// Boxed tool rendering — frame + background adapted from pi-tool-display's
// user-message-box renderer (MIT © 2026 MasuRii), simplified for tool rows.
// Display-only: consumes plain text/component lines, draws the rounded frame
// (`╭─ title ─╮ … ╰──╯`) with the theme's border/accent colors and the
// userMessageBg background fill, width-responsive, cached per (width, content).
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

// SAFETY: structural subset of pi's ExtensionRuntime theme object; renderers
// only ever touch fg/bold/getBgAnsi, all guarded with try/catch below.
export interface BoxTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  bg?(color: string, text: string): string;
  getBgAnsi?(color: string): string;
}

const ANSI_SGR_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ANSI_BG_RESET = "\u001b[49m";
const OSC_PROMPT_PATTERN =
  /\u001b\](?:133|633);[A-Z](?:;[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
const BG_COLOR = "userMessageBg";
const H_PADDING = 1; // content columns between border and text (same as user box)

export interface BoxStyle {
  /** short title shown in the top border, e.g. " read " */
  title: string;
  /** color role for the title text (theme.fg role name) */
  titleColor?: string;
}

function sanitizeAnsi(text: string): string {
  // keep general SGR codes (colors in tool output survive); strip prompt-control
  // OSC sequences and stray background resets so the fill applies cleanly.
  return text
    .replace(OSC_PROMPT_PATTERN, "")
    .replace(/\u001b\[0?m(?=\u001b\[|$)/g, "");
}

function bgFill(theme: BoxTheme | undefined, text: string): string {
  if (!text) return text;
  try {
    if (typeof theme?.getBgAnsi === "function") {
      return `${theme.getBgAnsi(BG_COLOR)}${text}${ANSI_BG_RESET}`;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof theme?.bg === "function") {
      return theme.bg(BG_COLOR, text);
    }
  } catch {
    /* fall through */
  }
  return text;
}

function fgSafe(
  theme: BoxTheme | undefined,
  color: string,
  text: string,
): string {
  if (!text) return text;
  try {
    return theme ? theme.fg(color, text) : text;
  } catch {
    return text;
  }
}

function boldSafe(theme: BoxTheme | undefined, text: string): string {
  if (!text) return text;
  try {
    return theme?.bold ? theme.bold(text) : text;
  } catch {
    return text;
  }
}

function visuallyEmpty(line: string): boolean {
  return line.replace(ANSI_SGR_PATTERN, "").trim().length === 0;
}

export function topBorder(
  width: number,
  theme: BoxTheme | undefined,
  style: BoxStyle,
): string {
  const inner = Math.max(0, width - 2);
  const t = truncateToWidth(style.title, inner, "");
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(t)));
  const row = `${fgSafe(theme, "border", "╭")}${fgSafe(theme, style.titleColor ?? "accent", boldSafe(theme, t))}${fgSafe(theme, "border", `${fill}╮`)}`;
  return bgFill(theme, row);
}

export function bottomBorder(
  width: number,
  theme: BoxTheme | undefined,
): string {
  const inner = Math.max(0, width - 2);
  return bgFill(theme, fgSafe(theme, "border", `╰${"─".repeat(inner)}╯`));
}

function contentLine(
  line: string,
  width: number,
  theme: BoxTheme | undefined,
): string {
  const inner = Math.max(1, width - 2 - H_PADDING * 2);
  const clean = sanitizeAnsi(line.replace(/[ \t]+$/, ""));
  const content = truncateToWidth(clean, inner, "", true);
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(content)));
  const side = " ".repeat(H_PADDING);
  return bgFill(
    theme,
    `${fgSafe(theme, "border", "│")}${side}${content}${pad}${side}${fgSafe(theme, "border", "│")}`,
  );
}

/**
 * Frame raw content lines in the user-box style. Long lines are wrapped
 * (word-aware), and empty edge lines are trimmed. The frame has no internal
 * spacer rows so tool output stays visually continuous.
 */
export function boxLines(
  lines: string[],
  width: number,
  theme: BoxTheme | undefined,
  style: BoxStyle,
): string[] {
  // interior blank lines are kept; leading/trailing blanks are trimmed here
  let start = 0;
  let end = lines.length;
  while (start < end && visuallyEmpty(lines[start] ?? "")) start++;
  while (end > start && visuallyEmpty(lines[end - 1] ?? "")) end--;
  const content = lines.slice(start, end);

  // Leave a two-column safety margin. Self-shell rows can be rendered at the
  // terminal's full width; exact-width border rows may wrap at the right edge
  // on terminals that commit the final cell before the reset sequence.
  const w = Math.max(12, width - 2);
  const out: string[] = [topBorder(w, theme, style)];
  for (const line of content) {
    for (const wrapped of wrapPlain(line, w - 2 - H_PADDING * 2)) {
      out.push(contentLine(wrapped, w, theme));
    }
  }
  out.push(bottomBorder(w, theme));
  return out;
}

/** Wrap plain output with pi-tui's ANSI-aware, long-token-safe wrapper. */
export function wrapPlain(line: string, width: number): string[] {
  return wrapTextWithAnsi(sanitizeAnsi(line), Math.max(8, width));
}

/** A reusable Component that draws content inside the user-box frame. */
export class Boxed implements Component {
  private cacheKey = "";
  private cached: string[] = [];
  constructor(
    private readonly build: (width: number) => {
      lines: string[];
      style: BoxStyle;
    },
    private readonly theme: BoxTheme | undefined,
  ) {}
  render(width: number): string[] {
    const { lines, style } = this.build(width);
    const key = `${width}\u0000${style.title}\u0000${lines.join("\u0001")}`;
    if (key !== this.cacheKey || this.cached.length === 0) {
      this.cached = boxLines(lines, width, this.theme, style);
      this.cacheKey = key;
    }
    return this.cached;
  }
  invalidate(): void {
    this.cacheKey = "";
    this.cached = [];
  }
}
