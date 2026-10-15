import type { ReactNode } from 'react';

// Renders Jira wiki markup (what Jira Data Center stores in descriptions) as React elements, never raw HTML.
// Covers what tickets use: headings, bold/italic/strike, {{code}}, links, mentions, lists, tables, {code}/{quote} blocks.
export default function Wiki({ text }: { text: string }) {
  return <div className="wiki">{blocks(text.replaceAll('\r\n', '\n').split('\n'))}</div>;
}

const INLINE =
  /\{\{(?<code>[^}]+)\}\}|\[(?<label>[^\]|]+)(?:\|(?<href>[^\]]+))?\]|(?<url>https?:\/\/[^\s\]|]+)|(?<![\p{L}\p{N}*])\*(?!\s)(?<b>[^*]+?)(?<!\s)\*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}_])_(?!\s)(?<i>[^_]+?)(?<!\s)_(?![\p{L}\p{N}])|(?<![\p{L}\p{N}-])-(?![\s-])(?<s>[^-]+?)(?<![\s-])-(?![\p{L}\p{N}])|\{color(?::[^}]*)?\}/gu;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const { code, label, href, url, b, i, s } = m.groups!;
    const key = m.index;
    out.push(text.slice(at, key));
    at = key + m[0].length;
    if (code) out.push(<code key={key}>{code}</code>);
    else if (label?.startsWith('~')) out.push(`@${label.slice(1)}`);
    else if (label) {
      const target = (href ?? label).trim();
      out.push(/^(https?|mailto):/i.test(target) ? <a key={key} href={target} target="_blank" rel="noreferrer">{inline(label)}</a> : m[0]);
    } else if (url) out.push(<a key={key} href={url} target="_blank" rel="noreferrer">{url}</a>);
    else if (b) out.push(<strong key={key}>{inline(b)}</strong>);
    else if (i) out.push(<em key={key}>{inline(i)}</em>);
    else if (s) out.push(<del key={key}>{inline(s)}</del>);
  }
  out.push(text.slice(at));
  return out;
}

const LIST = /^\s*([*#]+|-)\s+(.*)$/;
const TABLE = /^\s*\|/;

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const fence = /^\s*\{(code|noformat|quote|panel)(?::[^}]*)?\}\s*$/.exec(line);
    const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
    // A run of lines of one kind: list items, table rows or paragraph text.
    const run = (test: (l: string) => boolean) => {
      let end = n;
      while (end < lines.length && test(lines[end])) end++;
      const taken = lines.slice(n, end);
      n = end - 1;
      return taken;
    };
    if (fence) {
      const close = lines.findIndex((l, j) => j > n && l.trim() === `{${fence[1]}}`);
      const inner = lines.slice(n + 1, close < 0 ? lines.length : close);
      n = close < 0 ? lines.length : close;
      out.push(fence[1] === 'code' || fence[1] === 'noformat' ? <pre key={n}>{inner.join('\n')}</pre> : <blockquote key={n}>{blocks(inner)}</blockquote>);
    } else if (heading) out.push(<h4 key={n}>{inline(heading[2])}</h4>);
    else if (/^\s*-{4,}\s*$/.test(line)) out.push(<hr key={n} />);
    else if (LIST.test(line)) out.push(list(run((l) => LIST.test(l)).map((l) => LIST.exec(l)!.slice(1) as [string, string]), n));
    else if (TABLE.test(line)) out.push(table(run((l) => TABLE.test(l)), n));
    else if (line.trim()) {
      const text = run((l) => !!l.trim() && !LIST.test(l) && !TABLE.test(l) && !/^\s*(h[1-6]\.\s|\{(code|noformat|quote|panel)[:}])/.test(l));
      out.push(<p key={n}>{text.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l)}</span>)}</p>);
    }
  }
  return out;
}

// Items are [marker, text]; a longer marker nests under the item above it. The last marker character picks the kind.
function list(items: [string, string][], key: number, depth = 1): ReactNode {
  const children: ReactNode[] = [];
  for (let n = 0; n < items.length; n++) {
    let end = n + 1;
    while (end < items.length && items[end][0].length > depth) end++;
    const nested = items.slice(n + 1, end);
    children.push(<li key={n}>{inline(items[n][1])}{nested.length > 0 && list(nested, n, depth + 1)}</li>);
    n = end - 1;
  }
  return items[0][0].endsWith('#') ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>;
}

// || starts a header cell, | a cell; pipes inside [links|...] stay in their cell.
function table(rows: string[], key: number) {
  return (
    <table key={key}>
      <tbody>
        {rows.map((row, r) => {
          const cells = [...row.trim().matchAll(/(\|\|?)((?:\[[^\]]*\]|[^|])*)/g)];
          return (
            <tr key={r}>
              {cells.slice(0, cells.at(-1)?.[2].trim() ? undefined : -1).map(([, bar, text], c) =>
                bar === '||' ? <th key={c}>{inline(text.trim())}</th> : <td key={c}>{inline(text.trim())}</td>,
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
