// Terminal text handling: tool-result extraction, sanitization and the SGR
// escape knowledge the frame relies on. Every line returned here is safe to
// place inside one pi-tui row: no line terminators, no tabs, no C0/C1
// controls, no cursor or OSC escapes.
//
// Tool output is reduced to plain text (as pi core does): output colors can be
// unbalanced or truncated mid-sequence and would bleed into the frame. Only
// this package's own styling (syntax highlighting) keeps its SGR colors.
import { imageFallback } from "@earendil-works/pi-tui";

/** An image content part as it appears in a tool result. */
export interface ImagePart {
  mimeType?: string;
  data?: string;
}

interface ContentPart extends ImagePart {
  type?: string;
  text?: string;
}

interface ToolResultLike {
  content?: unknown;
  details?: { error?: unknown };
}

// pi-tui measures a tab as three columns; expanding it keeps borders aligned.
const TAB = "   ";
// CSI (any final byte), OSC (BEL or ST terminated, or cut off), or any other
// two-byte escape; a lone trailing ESC is matched too.
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|.)?/g;
const SGR = /^\u001b\[[0-9;:]*m$/;
const SGR_ANYWHERE = /\u001b\[[0-9;:]*m/g;
const SGR_FULL_RESET = /\u001b\[0?m/g;
const SGR_BG_RESET = "\u001b[49m";
// C0 controls, DEL, C1 controls and interlinear annotation marks. ESC is
// excluded: escapes are resolved first, so any ESC left starts a kept SGR.
const CONTROL_CHARS = /[\u0000-\u001a\u001c-\u001f\u007f-\u009f\ufff9-\ufffb]/g;

type EscapePolicy = (sequence: string) => string;

const dropEscape: EscapePolicy = () => "";
const keepSgrOnly: EscapePolicy = (sequence) => (SGR.test(sequence) ? sequence : "");

// A carriage return rewinds the row, so only the text after the last one is
// what a terminal would show (progress bars, spinners).
function lastCarriageSegment(line: string): string {
  const cut = line.lastIndexOf("\r");
  return cut === -1 ? line : line.slice(cut + 1);
}

function linesWith(text: string, policy: EscapePolicy): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      lastCarriageSegment(line)
        .replace(ESCAPE_SEQUENCE, policy)
        .replaceAll("\t", TAB)
        .replace(CONTROL_CHARS, ""),
    );
}

/** Untrusted text (tool output, arguments) as plain, row-safe lines. */
export function plainLines(text: string): string[] {
  return linesWith(text, dropEscape);
}

/** This package's own styled text as row-safe lines, colors kept. */
export function styledLines(text: string): string[] {
  return linesWith(text, keepSgrOnly);
}

function parts(result: ToolResultLike | undefined): ContentPart[] {
  return Array.isArray(result?.content) ? (result.content as ContentPart[]) : [];
}

function isTextPart(part: ContentPart | null): part is ContentPart & { text: string } {
  return part?.type === "text" && typeof part.text === "string";
}

/** Plain lines of a tool result's text parts, with any details.error first. */
export function resultLines(result: unknown): string[] {
  const typed = result as ToolResultLike | undefined;
  const text = parts(typed)
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n");
  const lines = plainLines(text);
  const error = typed?.details?.error;
  if (error === undefined || error === null) return lines;
  return [...plainLines(String(error)), ...lines];
}

/** One placeholder line per image part that pi will not draw itself. */
export function imageNotes(result: unknown, isDrawnByPi: (part: ImagePart) => boolean): string[] {
  return parts(result as ToolResultLike | undefined)
    .filter((part) => part?.type === "image" && !isDrawnByPi(part))
    .map((part) => plainLines(imageFallback(part.mimeType ?? "image/unknown")).join(" "));
}

/**
 * Paint text on a background. A full SGR reset inside the text would also
 * clear the fill, so the background is re-applied after every reset.
 */
export function withBackground(text: string, bgAnsi: string): string {
  const refilled = text.replace(SGR_FULL_RESET, (reset) => `${reset}${bgAnsi}`);
  return `${bgAnsi}${refilled}${SGR_BG_RESET}`;
}

/** True when a line shows nothing but whitespace once colors are removed. */
function isBlankLine(line: string): boolean {
  return line.replace(SGR_ANYWHERE, "").trim() === "";
}

/** Drop leading and trailing blank lines; interior blank lines are kept. */
export function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankLine(lines[start])) start++;
  while (end > start && isBlankLine(lines[end - 1])) end--;
  return lines.slice(start, end);
}
