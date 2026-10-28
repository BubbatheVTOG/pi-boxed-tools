// pi-boxed-tools — boxed tool-call rendering for pi's text tools.
//
// Display-only: registers renderers for read/grep/find/ls/bash through pi's
// registerToolRenderer API and never replaces the tools themselves, so pi's
// built-in definitions — schema, prompt metadata, settings such as
// shellCommandPrefix/shellPath/images.autoResize, and execution — stay
// untouched. Resolvers are consulted before a registered tool's own
// renderers, so these boxes win over any same-name tool override.
import {
  highlightCode,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, type Component } from "@earendil-works/pi-tui";
import { Boxed, type BoxTheme } from "./box.ts";
import { imageNotes, plainLines, styledLines, type ImagePart } from "./output.ts";
import { callHeader, commandHeader, resultContent, type RowLabel } from "./tool-row.ts";

type ToolArgs = Record<string, unknown>;
type RenderResult = NonNullable<ToolDefinition["renderResult"]>;

interface SpecBase {
  name: string;
}

interface DetailSpec extends SpecBase {
  /** Muted argument summary for the header row. */
  detail: (args: ToolArgs) => string;
}

interface CommandSpec extends SpecBase {
  /** The command text, shown highlighted. */
  command: (args: ToolArgs) => string;
}

type ToolSpec = DetailSpec | CommandSpec;

function isCommandSpec(spec: ToolSpec): spec is CommandSpec {
  return "command" in spec;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Format a value only when it is present. */
function optional(value: unknown, format: (shown: string) => string): string {
  const shown = text(value);
  return shown ? format(shown) : "";
}

const SPECS: ToolSpec[] = [
  {
    name: "read",
    detail: (a) =>
      text(a.path) +
      optional(a.offset, (v) => ` from ${v}`) +
      optional(a.limit, (v) => ` (${v} lines)`),
  },
  {
    name: "grep",
    detail: (a) =>
      text(a.pattern) + optional(a.path, (v) => ` in ${v}`) + optional(a.glob, (v) => ` (${v})`),
  },
  {
    name: "find",
    detail: (a) => text(a.pattern) + optional(a.path, (v) => ` in ${v}`),
  },
  {
    name: "ls",
    detail: (a) => text(a.path),
  },
  {
    name: "bash",
    command: (a) => text(a.command),
  },
];

// Blank edge lines (a trailing newline, a leading blank line) are not part of
// what the command does and would inflate the header's hidden-line count.
function trimBlankEdgeLines(source: string): string {
  return source.replace(/^\s*\n/, "").trimEnd();
}

// highlightCode returns one string per source line; each is sanitized so a
// stray CR or control byte cannot corrupt the row it lands in.
function highlightedCommand(spec: CommandSpec, args: ToolArgs): string[] {
  const source = trimBlankEdgeLines(spec.command(args).replace(/\r\n?/g, "\n"));
  return highlightCode(source, "bash").flatMap(styledLines);
}

/** Argument detail flattened to one row-safe line. */
function headerDetail(spec: DetailSpec, args: ToolArgs): string {
  return plainLines(spec.detail(args)).join(" ");
}

/** A single header row, recomputed only when the width changes. */
function headerRow(build: (width: number) => string): Component {
  let width = -1;
  let rows: string[] = [];
  return {
    render(next: number) {
      if (next !== width) {
        rows = [build(next)];
        width = next;
      }
      return rows;
    },
    invalidate() {
      width = -1;
    },
  };
}

function callRenderer(spec: ToolSpec) {
  return (args: unknown, theme: BoxTheme): Component => {
    const call = (args ?? {}) as ToolArgs;
    const build = isCommandSpec(spec)
      ? commandHeader({ name: spec.name, command: highlightedCommand(spec, call) }, theme)
      : callHeader({ name: spec.name, detail: headerDetail(spec, call) }, theme);
    return headerRow(build);
  };
}

function rowLabel(spec: ToolSpec): RowLabel {
  return { name: spec.name, kind: isCommandSpec(spec) ? "command" : "listing" };
}

// Only an expanded result shows the command, so only it pays for highlighting.
function expandedCommand(spec: ToolSpec, view: { expanded: boolean; args: unknown }): string[] {
  if (!view.expanded || !isCommandSpec(spec)) return [];
  return highlightedCommand(spec, (view.args ?? {}) as ToolArgs);
}

// Mirrors pi's own condition (tool-execution.js): it draws an image part
// below the row only when the terminal can, the user allows it, and the part
// carries data and a type. Every other image part gets a placeholder line.
function piImageDrawer(
  context: { showImages?: boolean } | undefined,
): (part: ImagePart) => boolean {
  const canDraw = Boolean(getCapabilities().images) && context?.showImages === true;
  return (part) => canDraw && Boolean(part.data && part.mimeType);
}

function resultRenderer(spec: ToolSpec): RenderResult {
  const label = rowLabel(spec);
  // oxlint-disable-next-line max-params -- arity fixed by pi's ToolDefinition.renderResult
  return (result, options, theme, context) => {
    const expanded = options.expanded === true;
    const build = () =>
      resultContent(
        {
          result,
          expanded,
          isPartial: options.isPartial === true,
          isError: context?.isError === true,
          command: expandedCommand(spec, { expanded, args: context?.args }),
          images: imageNotes(result, piImageDrawer(context)),
          label,
        },
        theme,
      );
    return new Boxed(build, theme);
  };
}

function boxedRenderers(spec: ToolSpec): ToolRenderers {
  return {
    renderShell: "self",
    renderCall: callRenderer(spec),
    renderResult: resultRenderer(spec),
  };
}

const RENDERERS = new Map(SPECS.map((spec) => [spec.name, boxedRenderers(spec)]));

export default function (pi: ExtensionAPI): void {
  pi.registerToolRenderer((toolName, next) => RENDERERS.get(toolName) ?? next());
}
