// Pure rendering of one tool row: the one-line call header and the boxed
// result body for every state (running, failed, empty, collapsed, expanded).
import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BoxContent, BoxStyle, BoxTheme } from "./box.ts";
import { resultLines, trimBlankEdges } from "./output.ts";

const PREVIEW_LINES = 8;
const COMMAND_RULE_WIDTH = 24;

interface Status {
  marker: string;
  color: string;
}

const RUNNING: Status = { marker: "⋯", color: "warning" };
const FAILED: Status = { marker: "✗", color: "error" };
const SUCCEEDED: Status = { marker: "✓", color: "success" };

/** Commands have an exit status and newest-last output; listings do not. */
export type RowKind = "command" | "listing";

export interface RowLabel {
  name: string;
  kind: RowKind;
}

export interface ResultView {
  result: unknown;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  /** Highlighted command lines, shown when expanded; empty otherwise. */
  command: string[];
  /** Placeholder lines for images pi will not draw; empty otherwise. */
  images: string[];
  label: RowLabel;
}

export interface CallDetail {
  name: string;
  /** Muted argument summary shown after the tool name; must be one line. */
  detail: string;
}

export interface CommandCall {
  name: string;
  /** Highlighted, row-safe command lines. */
  command: string[];
}

type Preview = (lines: string[], theme: BoxTheme) => string[];

function expandHint(): string {
  return keyHint("app.tools.expand", "to expand");
}

/** One header row: tool name plus muted argument detail, cut to width. */
export function callHeader(call: CallDetail, theme: BoxTheme): (width: number) => string {
  const title = theme.fg("toolTitle", `${call.name} `);
  const row = ` ${title}${theme.fg("muted", call.detail)}`;
  return (width) => truncateToWidth(row, width, "…");
}

/**
 * One header row for a command: its first line plus a hidden-line count. The
 * full command is shown inside the expanded result box, so long heredocs never
 * flood the transcript outside the frame.
 */
export function commandHeader(call: CommandCall, theme: BoxTheme): (width: number) => string {
  const prefix = ` ${theme.fg("toolTitle", `${call.name} `)}`;
  const extra = call.command.length - 1;
  const suffix = extra > 0 ? theme.fg("dim", ` (+${extra} lines · ${expandHint()})`) : "";
  const fixed = visibleWidth(prefix) + visibleWidth(suffix);
  return (width) => {
    const first = truncateToWidth(call.command[0] ?? "", Math.max(0, width - fixed), "…");
    return truncateToWidth(`${prefix}${first}${suffix}`, width, "");
  };
}

// A one-line command is already fully visible in the header.
function commandBlock(view: ResultView, theme: BoxTheme): string[] {
  if (!view.expanded || view.command.length <= 1) return [];
  return [...view.command, theme.fg("dim", "─".repeat(COMMAND_RULE_WIDTH))];
}

// Blank edges (a trailing newline above all) are trimmed before previewing so
// they neither take a preview row nor count as hidden lines.
function outputLines(view: ResultView, theme: BoxTheme): string[] {
  const text = resultLines(view.result);
  const colored = view.isError ? text.map((line) => theme.fg("error", line)) : text;
  const images = view.images.map((note) => theme.fg("muted", note));
  return trimBlankEdges([...colored, ...images]);
}

const headPreview: Preview = (lines, theme) => {
  if (lines.length <= PREVIEW_LINES) return lines;
  const hidden = lines.length - PREVIEW_LINES;
  const hint = theme.fg("dim", `… +${hidden} more lines · ${expandHint()}`);
  return [...lines.slice(0, PREVIEW_LINES), hint];
};

// Commands keep their newest lines: errors, summaries and pi's truncation
// footer (with the full-output path) are at the end.
const tailPreview: Preview = (lines, theme) => {
  if (lines.length <= PREVIEW_LINES) return lines;
  const hidden = lines.length - PREVIEW_LINES;
  const hint = theme.fg("dim", `… ${hidden} earlier lines · ${expandHint()}`);
  return [hint, ...lines.slice(-PREVIEW_LINES)];
};

interface KindPolicy {
  /** Title marker on success; listings have no exit status to report. */
  success?: Status;
  /** Collapsed view of finished output. */
  preview: Preview;
}

const KINDS: Record<RowKind, KindPolicy> = {
  command: { success: SUCCEEDED, preview: tailPreview },
  listing: { preview: headPreview },
};

function statusOf(view: ResultView): Status | undefined {
  if (view.isPartial) return RUNNING;
  if (view.isError) return FAILED;
  return KINDS[view.label.kind].success;
}

function styleOf(view: ResultView): BoxStyle {
  const { name } = view.label;
  const status = statusOf(view);
  if (!status) return { title: ` ${name} `, titleColor: "accent" };
  return { title: ` ${status.marker} ${name} `, titleColor: status.color };
}

// Streaming output always shows its newest lines.
function runningBody(view: ResultView, theme: BoxTheme): string[] {
  const running = theme.fg("warning", "running…");
  const output = outputLines(view, theme);
  if (output.length === 0) return [running];
  const visible = view.expanded ? output : tailPreview(output, theme);
  return [...visible, running];
}

function finishedBody(view: ResultView, theme: BoxTheme): string[] {
  const output = outputLines(view, theme);
  if (output.length === 0) return [theme.fg("muted", "(no output)")];
  return view.expanded ? output : KINDS[view.label.kind].preview(output, theme);
}

/** Box content for a tool result in its current state. */
export function resultContent(view: ResultView, theme: BoxTheme): BoxContent {
  const body = view.isPartial ? runningBody(view, theme) : finishedBody(view, theme);
  return {
    lines: [...commandBlock(view, theme), ...body],
    style: styleOf(view),
  };
}
