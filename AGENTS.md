# pi-boxed-tools maintainer instructions

A display-only pi extension that draws `read`, `grep`, `find`, `ls`, and
`bash` results inside a rounded, theme-filled frame. The global
`~/.pi/agent/AGENTS.md` coding principles apply; this file covers what is
specific to this package.

## Layout

| File                       | Responsibility                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `src/index.ts`             | Tool specs and the `registerToolRenderer` resolver for the five owned tool names           |
| `src/tool-row.ts`          | Pure row rendering: call headers and result body for every state                           |
| `src/box.ts`               | The frame: borders, background fill, wrapping, width cache (`Boxed` component)             |
| `src/output.ts`            | Terminal text: result extraction, sanitization, all SGR/escape knowledge                   |
| `tests/renderers.test.mjs` | Deterministic harness: resolver contract, every render state, width and sanitization edges |

## Invariants

- **Display-only.** The package registers one `registerToolRenderer`
  resolver and never calls `registerTool`. Replacing a built-in would drop
  pi's settings for it (`shellCommandPrefix`, `shellPath`,
  `images.autoResize`) and its prompt metadata. Resolvers run before a tool's
  own renderers, so the boxes win over any same-name tool override; every
  other tool name must defer to `next()`.
- **One row per string.** Every line placed in a frame or header must come
  through `output.ts`: no CR/LF, tabs, C0/C1 controls, or cursor/OSC escapes.
  A raw byte in a row breaks border alignment or redraws.
- **Untrusted text is plain.** Tool output and arguments go through
  `plainLines`/`resultLines`, which drop every escape (as pi core does);
  output colors can be unbalanced and would bleed into the frame. Only this
  package's own highlighting uses `styledLines`, which keeps SGR.
- **Escape knowledge lives in `output.ts`.** It is the only file allowed
  control-character regexes (`no-control-regex` is off there and in tests).
- **Headers are one row**, cut by visible width with `truncateToWidth` —
  never `String.slice`, which splits ANSI sequences.
- **No row is wider than `render(width)`.** The frame keeps a two-column right
  margin when it fits and is cut to the width when it cannot; an overwide row
  physically wraps and corrupts pi's differential redraw.
- **Commands preview their tail.** Running and finished `bash` output keeps
  the newest lines in view (errors and pi's `Full output:` truncation footer
  are last), so the box does not jump when a command finishes. File and
  listing tools preview their head.
- **Images.** pi draws an image part below the row only when the terminal
  supports images, `showImages` is on, and the part has data and a MIME type
  (`tool-execution.js`). The box lists a sanitized `imageFallback` placeholder
  for exactly the parts pi will not draw.
- No runtime dependencies; pi supplies the peer packages.

## Commands

```bash
npm install        # dev tools; npm also installs the pi peer packages locally
npm run check      # fmt:check + lint + test — run before claiming done
npm run fmt        # oxfmt in place
npm run lint       # oxlint --deny-warnings src tests
npm test           # harness; needs a global pi install (or PI_PACKAGE_DIR)
```

The harness loads `src/index.ts` through pi's own jiti with the global pi
package aliased, and calls `initTheme("dark")` because `keyHint` and
`highlightCode` read pi's global theme. Assert on visible text (strip SGR)
when checking highlighted output.

Type-check against the locally installed peer packages (TypeScript is not a
dependency; run after `npm install` for type-level changes):

```bash
npx -y -p typescript@5 tsc -p tsconfig.json
```

## Lint limits

`.oxlintrc.json` encodes the global principles: `complexity` ≤ 10,
`max-depth` 2, `max-params` 2, `max-nested-callbacks` 3, and no nested
ternaries, negated conditions, lonely ifs, or else-after-return. Satisfy them
with parameter objects, closures, or extraction, not with rest-destructuring
tricks. The only accepted suppression is an arity fixed by pi's API (e.g.
`renderResult`), with an `-- reason` on the disable comment.

## Activation

Pi runs this package from a pinned Git commit
(`git:github.com/BubbatheVTOG/pi-boxed-tools@<commit>`), not from this
checkout. Publishing, each step a separate approval:

1. Commit and push this repository.
2. Bump the pin in `~/git/pi-config/config/settings.json` and promote it to
   `~/.pi/agent/settings.json`.
3. `pi update git:github.com/BubbatheVTOG/pi-boxed-tools` — reconciles the
   checkout to the configured ref (package updates never move a pin; a bare
   `pi update` updates pi itself).
4. `/reload` in pi.

Static checks here do not prove live behavior. To try the checkout live
without touching settings, run pi with only this extension:
`pi -ne -e ~/git/pi-boxed-tools/src/index.ts --no-session`.
