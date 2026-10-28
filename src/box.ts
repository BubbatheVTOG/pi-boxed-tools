// Boxed tool rendering — frame + background adapted from pi-tool-display's
// user-message-box renderer (MIT © 2026 MasuRii), simplified for tool rows.
// Display-only: frames already-sanitized content lines with a rounded border
// (`╭─ title ─╮ … ╰──╯`), the theme's border/accent colors and the
// userMessageBg background fill. Content is built lazily once and framed once
// per width; invalidate() drops both so theme changes are picked up.
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { trimBlankEdges, withBackground } from "./output.ts";

// Structural subset of pi's Theme; bg/getBgAnsi are optional so the frame
// degrades to an unfilled box on minimal themes (and in tests).
export interface BoxTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  bg?(color: string, text: string): string;
  getBgAnsi?(color: string): string;
}

export interface BoxStyle {
  /** short title shown in the top border, e.g. " read " */
  title: string;
  /** color role for the title text (theme.fg role name) */
  titleColor: string;
}

export interface BoxContent {
  lines: string[];
  style: BoxStyle;
}

const BG_COLOR = "userMessageBg";
const H_PADDING = 1; // content columns between border and text (same as user box)
// Two borders, both paddings and one content column.
const MIN_FRAME_WIDTH = 2 + H_PADDING * 2 + 1;
// Self-shell rows can be rendered at the terminal's full width; exact-width
// border rows may wrap on terminals that commit the final cell before the
// reset sequence, so the frame keeps a two-column margin when it fits.
const RIGHT_MARGIN = 2;

/** Geometry and theme for one framing pass. */
interface Frame {
  theme: BoxTheme;
  /** Columns the caller gave render(); no row may be wider. */
  available: number;
  /** Outer box width including both borders. */
  width: number;
  /** Content columns between the side padding. */
  inner: number;
}

function frameFor(available: number, theme: BoxTheme): Frame {
  const width = Math.max(MIN_FRAME_WIDTH, available - RIGHT_MARGIN);
  return { theme, available, width, inner: width - 2 - H_PADDING * 2 };
}

// Below MIN_FRAME_WIDTH the frame cannot fit, so its rows are cut to the
// available columns rather than overflowing (an overwide row physically wraps
// and corrupts pi's differential redraw).
function clampRows(rows: string[], frame: Frame): string[] {
  if (frame.width <= frame.available) return rows;
  return rows.map((row) => truncateToWidth(row, Math.max(0, frame.available), ""));
}

function bgFill(theme: BoxTheme, text: string): string {
  if (typeof theme.getBgAnsi === "function") {
    return withBackground(text, theme.getBgAnsi(BG_COLOR));
  }
  if (typeof theme.bg === "function") return theme.bg(BG_COLOR, text);
  return text;
}

function bold(theme: BoxTheme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

function topBorder(frame: Frame, style: BoxStyle): string {
  const { theme } = frame;
  const span = frame.width - 2;
  const title = truncateToWidth(style.title, span, "");
  const fill = "─".repeat(Math.max(0, span - visibleWidth(title)));
  const left = theme.fg("border", "╭");
  const styledTitle = theme.fg(style.titleColor, bold(theme, title));
  const right = theme.fg("border", `${fill}╮`);
  return bgFill(theme, `${left}${styledTitle}${right}`);
}

function bottomBorder(frame: Frame): string {
  const rule = "─".repeat(frame.width - 2);
  return bgFill(frame.theme, frame.theme.fg("border", `╰${rule}╯`));
}

function contentRow(frame: Frame, line: string): string {
  const content = truncateToWidth(line.replace(/[ \t]+$/, ""), frame.inner, "");
  const pad = " ".repeat(Math.max(0, frame.inner - visibleWidth(content)));
  const side = " ".repeat(H_PADDING);
  const border = frame.theme.fg("border", "│");
  return bgFill(frame.theme, `${border}${side}${content}${pad}${side}${border}`);
}

/**
 * Frame content lines in the user-box style. Long lines are wrapped
 * (ANSI-aware, long-token-safe) and blank edge lines are trimmed; interior
 * blank lines are kept so tool output stays visually continuous.
 */
function boxLines(content: BoxContent, frame: Frame): string[] {
  const rows = trimBlankEdges(content.lines)
    .flatMap((line) => wrapTextWithAnsi(line, frame.inner))
    .map((line) => contentRow(frame, line));
  return clampRows([topBorder(frame, content.style), ...rows, bottomBorder(frame)], frame);
}

/** A Component that draws lazily built content inside the user-box frame. */
export class Boxed implements Component {
  private content: BoxContent | undefined;
  private framedWidth = -1;
  private framed: string[] = [];

  constructor(
    private readonly build: () => BoxContent,
    private readonly theme: BoxTheme,
  ) {}

  render(width: number): string[] {
    this.content ??= this.build();
    if (width !== this.framedWidth) {
      this.framed = boxLines(this.content, frameFor(width, this.theme));
      this.framedWidth = width;
    }
    return this.framed;
  }

  invalidate(): void {
    this.content = undefined;
    this.framedWidth = -1;
    this.framed = [];
  }
}
