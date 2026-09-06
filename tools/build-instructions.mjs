import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Renders `instructions.md` into the build as a page the deployed application can link to.
 *
 * The instructions ship with the app because the people who need them are the people using a
 * deployment, who have no checkout and should not be sent to a source host to learn what a column
 * means. Markdown is the authored form — it reviews well in a pull request and reads fine on a
 * source host — and this converts it at build time so the runtime carries no Markdown library and
 * the page works even if the application itself fails to start.
 *
 * The supported subset is exactly what `instructions.md` uses: headings, paragraphs, tables,
 * bullet and numbered lists, blockquotes, fenced code, horizontal rules, and inline emphasis,
 * code, and links. Anything outside it renders as literal text rather than silently vanishing —
 * visible in review, which is the failure mode to prefer.
 */

const escapeHtml = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function inline(text) {
  let html = escapeHtml(text);
  html = html.replaceAll(/`([^`]+)`/gu, '<code>$1</code>');
  html = html.replaceAll(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
  // Both spellings: Prettier normalises `*italic*` to `_italic_` when it formats the source, so a
  // renderer that knew only one would emit the other as literal underscores.
  html = html.replaceAll(/(^|[\s(])\*([^*]+)\*/gu, '$1<em>$2</em>');
  html = html.replaceAll(/(^|[\s(])_([^_]+)_/gu, '$1<em>$2</em>');
  // Only http(s) and same-document links: a Markdown link is authored content, but a generated
  // page should not be a place where a `javascript:` URL could arrive unnoticed.
  html = html.replaceAll(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|#[^)\s]*|\.\/[^)\s]+)\)/gu,
    (_, label, href) =>
      href.startsWith('http')
        ? `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`
        : `<a href="${href}">${label}</a>`,
  );
  return html;
}

function renderTable(rows) {
  const cells = (row) =>
    row
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map((cell) => cell.trim());
  const [header, , ...body] = rows;
  const head = cells(header)
    .map((cell) => `<th>${inline(cell)}</th>`)
    .join('');
  const rest = body
    .map(
      (row) =>
        `<tr>${cells(row)
          .map((cell) => `<td>${inline(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('\n');
  return `<div class="table-scroll"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rest}\n</tbody>\n</table></div>`;
}

function render(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
    } else if (line.startsWith('```')) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
    } else if (/^#{1,4} /u.test(line)) {
      const level = line.match(/^#+/u)[0].length;
      const text = line.slice(level + 1);
      // Slugged so the page can be linked into by section.
      const id = text
        .toLowerCase()
        .replaceAll(/[^\da-z ]/gu, '')
        .replaceAll(/ +/gu, '-');
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      index += 1;
    } else if (line.trim() === '---') {
      out.push('<hr />');
      index += 1;
    } else if (line.startsWith('|')) {
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) {
        rows.push(lines[index]);
        index += 1;
      }
      out.push(renderTable(rows));
    } else if (/^[-*] /u.test(line)) {
      const items = [];
      while (
        index < lines.length &&
        (/^[-*] /u.test(lines[index]) || /^ {2,}\S/u.test(lines[index]))
      ) {
        if (/^[-*] /u.test(lines[index])) items.push(lines[index].slice(2));
        else items[items.length - 1] += ` ${lines[index].trim()}`;
        index += 1;
      }
      out.push(`<ul>\n${items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</ul>`);
    } else if (/^\d+\. /u.test(line)) {
      const items = [];
      while (
        index < lines.length &&
        (/^\d+\. /u.test(lines[index]) || /^ {2,}\S/u.test(lines[index]))
      ) {
        if (/^\d+\. /u.test(lines[index])) items.push(lines[index].replace(/^\d+\. /u, ''));
        else items[items.length - 1] += ` ${lines[index].trim()}`;
        index += 1;
      }
      out.push(`<ol>\n${items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</ol>`);
    } else if (line.startsWith('> ')) {
      const body = [];
      while (index < lines.length && lines[index].startsWith('> ')) {
        body.push(lines[index].slice(2));
        index += 1;
      }
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
    } else {
      const body = [];
      while (
        index < lines.length &&
        lines[index].trim() !== '' &&
        !/^([-*] |\d+\. |#{1,4} |\||>|```)/u.test(lines[index])
      ) {
        body.push(lines[index]);
        index += 1;
      }
      out.push(`<p>${inline(body.join(' '))}</p>`);
    }
  }

  return out.join('\n');
}

// Linked rather than inlined: the deployment policy sets `style-src 'self'` with no
// 'unsafe-inline', so a <style> block here would be blocked and the page would render unstyled.
const stylesheet = `:root {
  --ink: #172223;
  --forest: #153d39;
  --mint: #bfe9d4;
  --paper: #f5f2e9;
  --line: rgba(23, 34, 35, 0.16);
  color-scheme: light;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.5rem 1.25rem 5rem;
  background: var(--paper);
  color: var(--ink);
  /* System fonts only. The application's webfonts are hashed into its bundle and cannot be
     referenced from a page generated outside it, and naming them here would only mislead. */
  font: 16px/1.65 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; }
a { color: var(--forest); }
h1, h2, h3, h4 { line-height: 1.25; margin: 2.25rem 0 0.75rem; }
h1 { margin-top: 0; font-size: 2rem; }
h2 { font-size: 1.4rem; border-top: 1px solid var(--line); padding-top: 1.75rem; }
/* A rule immediately before a heading would double the heading's own top rule. */
hr + h2 { border-top: none; padding-top: 0; }
h3 { font-size: 1.1rem; }
p, li { margin: 0.65rem 0; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgba(21, 61, 57, 0.08);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
pre {
  background: var(--forest);
  color: var(--mint);
  padding: 1rem;
  border-radius: 10px;
  overflow-x: auto;
}
pre code { background: none; color: inherit; padding: 0; }
blockquote {
  margin: 1rem 0;
  padding: 0.6rem 1rem;
  border-left: 3px solid var(--forest);
  background: rgba(21, 61, 57, 0.06);
}
.table-scroll { overflow-x: auto; margin: 1rem 0; }
table { border-collapse: collapse; width: 100%; min-width: 32rem; }
th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: rgba(21, 61, 57, 0.08); }
hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }
.back { display: inline-block; margin-bottom: 1.5rem; font-weight: 600; }
@media (max-width: 34rem) {
  body { padding: 1.5rem 1rem 4rem; }
  h1 { font-size: 1.6rem; }
}
`;

export function renderInstructions(source) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#101b1c" />
    <link rel="icon" href="./icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="./instructions.css" />
    <title>AckWatch instructions</title>
  </head>
  <body>
    <main>
      <a class="back" href="./">&larr; Back to AckWatch</a>
${render(source)
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
    </main>
  </body>
</html>
`;
}

export const instructionsStylesheet = stylesheet;

/** Exported so the dev server can render the same page the build writes, rather than a stale copy. */
export function readInstructions() {
  return renderInstructions(readFileSync('instructions.md', 'utf8'));
}

// Only when run as a script. Imported, this module just offers the renderer above.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/u, ''))) {
  const outputDirectory = process.argv[2] ?? 'dist';
  const page = readInstructions();
  mkdirSync(dirname(join(outputDirectory, 'instructions.html')), { recursive: true });
  writeFileSync(join(outputDirectory, 'instructions.html'), page);
  writeFileSync(join(outputDirectory, 'instructions.css'), stylesheet);
  process.stdout.write(
    `Instructions rendered to ${outputDirectory}/instructions.html (${page.length} bytes).\n`,
  );
}
