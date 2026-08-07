import { isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { errorMessage, runReadonlyQuery } from "../../api/backend";
import { saveCsv } from "../../lib/csv";
import { useStore } from "../../state/store";
import { highlightSql, SnippetActions } from "./sqlSnippet";

/** Fenced-block languages worth treating as runnable SQL. */
const SQL_LANGS = new Set(["sql", "postgres", "postgresql", "psql"]);

/** The bits of a hast node this file needs. react-markdown hands the source
 *  node to each component; reading the table off that is far steadier than
 *  trying to walk the rendered React tree back into rows. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** Every `tr` in the table, header row first, as plain cell text — the shape
 *  `downloadCsv` wants. */
function tableRows(node: HastNode): string[][] {
  const rows: string[][] = [];
  const walk = (n: HastNode) => {
    if (n.tagName === "tr") {
      rows.push(
        (n.children ?? [])
          .filter((c) => c.tagName === "th" || c.tagName === "td")
          .map(hastText),
      );
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return rows;
}

/** Flattens a rendered subtree back to its source text — used to recover the
 *  raw contents of a fenced block for Copy / Open in editor. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** A fenced code block: language label, Copy, and — for SQL — a one-click
 *  hand-off into a real query tab, which is the whole point of the assistant
 *  writing SQL in a database client. */
function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const isSql = lang != null && SQL_LANGS.has(lang);
  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span className="md-code__lang mono">{lang ?? "text"}</span>
        <SnippetActions text={code} openAsSql={isSql} />
      </div>
      <pre className="md-code__body">
        <code>{isSql ? highlightSql(code) : code}</code>
      </pre>
    </div>
  );
}

/**
 * Renders assistant replies as Markdown — GitHub-flavored, so the model's
 * tables and strikethrough work. User messages stay plain text: they're
 * whatever the user typed, and running that through a formatter would mangle
 * it. Memoized because the panel re-renders on every keystroke in the draft
 * input, and re-parsing every message each time is pure waste.
 */
export const Markdown = memo(function Markdown({
  content,
  source,
}: {
  content: string;
  /** The single statement behind this reply's table, when there is exactly
   *  one — lets the table be a short preview while the download still gets
   *  every row. */
  source?: { sessionId: string; sql: string; rowCount: number | null };
}) {
  const csvDelimiter = useStore((s) => s.csvDelimiter);
  const showToast = useStore((s) => s.showToast);
  const [exporting, setExporting] = useState(false);

  const save = (rows: (string | null)[][]) =>
    saveCsv(rows, "ai-results", csvDelimiter)
      // `null` means the save dialog was dismissed — not worth a notice.
      .then((path) => {
        if (path) showToast(`Saved ${path.split("/").pop()}`);
      })
      .catch((e) => showToast(errorMessage(e), "error"));

  /**
   * Exports the whole result rather than the rows on screen: the table is
   * only a preview, so scraping it would quietly hand back a short file.
   * Falls back to the rendered rows for a table with no query behind it
   * (one the model wrote out itself, say).
   */
  const exportTable = (rendered: string[][]) => {
    if (!source) {
      void save(rendered);
      return;
    }
    setExporting(true);
    void runReadonlyQuery(source.sessionId, source.sql)
      .then((result) => save([result.columns.map((c) => c.name), ...result.rows]))
      .catch((e) => showToast(errorMessage(e), "error"))
      .finally(() => setExporting(false));
  };

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children, node }) => {
            const rows = node ? tableRows(node as unknown as HastNode) : [];
            const shown = Math.max(0, rows.length - 1);
            // The trace's row count is the real total; the table may be a
            // preview of it.
            const total = source?.rowCount ?? shown;
            const truncated = total > shown;
            return (
              <div className="md-table">
                <div className="md-table__bar">
                  <span className="md-table__meta mono">
                    {truncated
                      ? `${shown} of ${total} rows`
                      : `${shown} ${shown === 1 ? "row" : "rows"}`}
                  </span>
                  {rows.length > 0 && (
                    <button
                      className="snippet-actions__btn"
                      onClick={() => exportTable(rows)}
                      disabled={exporting}
                      title={
                        truncated
                          ? `Save all ${total} rows as a CSV file`
                          : "Save this table as a CSV file"
                      }
                    >
                      {exporting ? "Exporting…" : "Download CSV"}
                    </button>
                  )}
                </div>
                {/* Scrolls inside the bubble instead of stretching the panel. */}
                <div className="md-table-wrap">
                  <table>{children}</table>
                </div>
              </div>
            );
          },
          pre: ({ children }) => {
            const codeEl = isValidElement(children) ? children : null;
            const className = codeEl
              ? ((codeEl.props as { className?: string }).className ?? "")
              : "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? null;
            return <CodeBlock code={textOf(children).replace(/\n$/, "")} lang={lang} />;
          },
          // target="_blank" so a stray link can never navigate the webview
          // away from the app and take its state with it.
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
