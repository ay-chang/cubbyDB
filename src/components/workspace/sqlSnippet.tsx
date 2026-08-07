import { useState, type ReactNode } from "react";

import { copyToClipboard } from "../../api/backend";
import { SQL_KEYWORDS } from "../../lib/sqlSchema";
import { useStore } from "../../state/store";

/** Shared by the two places the assistant shows SQL: fenced code blocks in a
 *  reply, and the statements listed under a message's tool trace. */

const SQL_KEYWORD_SET = new Set(SQL_KEYWORDS);

/** One pass in precedence order: comments and quoted runs are matched before
 *  words, so a keyword inside a string or an identifier never gets colored as
 *  one. Double-quoted runs are matched but left unstyled — in Postgres they're
 *  quoted identifiers, not strings. */
const SQL_TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z_0-9$]*)/g;

/** Lightweight display-only highlighting, using the same keyword list and
 *  color tokens as the real editor. Not a parser — it colors comments,
 *  strings, numbers and keywords, which is all a short snippet needs. */
export function highlightSql(code: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of code.matchAll(SQL_TOKEN)) {
    const start = match.index;
    const [text, comment, single, , num, word] = match;
    if (start > last) out.push(code.slice(last, start));
    if (comment) {
      out.push(<span key={key++} className="md-sql--comment">{text}</span>);
    } else if (single) {
      out.push(<span key={key++} className="md-sql--string">{text}</span>);
    } else if (num) {
      out.push(<span key={key++} className="md-sql--number">{text}</span>);
    } else if (word && SQL_KEYWORD_SET.has(word.toLowerCase())) {
      out.push(<span key={key++} className="md-sql--keyword">{text}</span>);
    } else {
      out.push(text);
    }
    last = start + text.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/**
 * Copy, and — when the snippet is really SQL — a one-click hand-off into a
 * query tab, which is the whole point of the assistant producing SQL in a
 * database client. `openAsSql` is off by default because a fenced block can
 * be any language, and a trace's `detail` is only a statement for the
 * SQL-running tools.
 */
export function SnippetActions({
  text,
  openAsSql = false,
  tabTitle = "ai.sql",
}: {
  text: string;
  openAsSql?: boolean;
  tabTitle?: string;
}) {
  const newTab = useStore((s) => s.newTab);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void copyToClipboard(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="snippet-actions">
      {openAsSql && (
        <button
          className="snippet-actions__btn"
          onClick={() => void newTab({ title: tabTitle, sql: text })}
          title="Open this SQL in a new query tab"
        >
          Open in editor
        </button>
      )}
      <button className="snippet-actions__btn" onClick={copy} title="Copy to clipboard">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
