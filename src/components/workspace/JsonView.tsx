import { useState } from "react";

import {
  collapseChain,
  humanizeKey,
  isJsonObject,
  isNonEmptyContainer,
  summarize,
  tableColumns,
  type JsonObject,
} from "../../lib/jsonShape";

/**
 * The cell inspector's "Structured" view of a JSON value: laid out as a
 * readable document rather than as formatted source. Keys become plain-
 * language labels (the raw key is on hover); each group shows its plain
 * fields first as a label/value sheet, then its nested groups — top-level
 * ones as cards, deeper ones under smaller headings. Chains of one-field
 * wrapper objects collapse into a single heading ("Quote contact › Person").
 * Lists of objects become tables, lists of plain values chips. Read-only,
 * like the inspector.
 */
export function JsonView({ value }: { value: unknown }) {
  return (
    <div className="json-view">
      {Array.isArray(value) ? (
        <JsonList list={value} depth={0} />
      ) : isJsonObject(value) ? (
        <JsonObjectBody object={value} depth={0} />
      ) : (
        <JsonScalar value={value} />
      )}
    </div>
  );
}

/** An object's plain fields as one sheet, then each nested group. */
function JsonObjectBody({ object, depth }: { object: JsonObject; depth: number }) {
  const entries = Object.entries(object);
  if (entries.length === 0) return <span className="json-view__empty">No fields</span>;
  const fields = entries.filter(([, v]) => !isNonEmptyContainer(v));
  const groups = entries.filter(([, v]) => isNonEmptyContainer(v)) as Array<
    [string, JsonObject | unknown[]]
  >;
  return (
    <>
      {fields.length > 0 && (
        <dl className="json-view__sheet">
          {fields.map(([key, v]) => (
            <div key={key} className="json-view__row">
              <dt className="json-view__label" title={key}>
                {humanizeKey(key)}
              </dt>
              <dd className="json-view__value">
                <JsonScalar value={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {groups.map(([key, v]) => (
        <JsonGroup key={key} rawKey={key} value={v} depth={depth} />
      ))}
    </>
  );
}

/** A nested object or list, under a heading that collapses it: a card at
 *  the top level, a smaller heading inside one. */
function JsonGroup({
  rawKey,
  value,
  depth,
}: {
  rawKey: string;
  value: JsonObject | unknown[];
  depth: number;
}) {
  const [open, setOpen] = useState(true);
  const chain = collapseChain(rawKey, value);
  const title = chain.keys.map(humanizeKey).join(" › ");
  const card = depth === 0;
  return (
    <section className={card ? "json-view__card" : "json-view__group"}>
      <button
        className={card ? "json-view__card-head" : "json-view__group-head"}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={chain.keys.join(".")}
      >
        <span className={"json-view__chevron" + (open ? " json-view__chevron--open" : "")}>
          ▸
        </span>
        <span className="json-view__title">{title}</span>
        {(!open || Array.isArray(chain.value)) && (
          <span className="json-view__summary">{summarize(chain.value)}</span>
        )}
      </button>
      {open && (
        <div className={card ? "json-view__card-body" : "json-view__group-body"}>
          {Array.isArray(chain.value) ? (
            <JsonList list={chain.value} depth={depth + 1} />
          ) : (
            <JsonObjectBody object={chain.value} depth={depth + 1} />
          )}
        </div>
      )}
    </section>
  );
}

function JsonList({ list, depth }: { list: unknown[]; depth: number }) {
  if (list.length === 0) return <span className="json-view__empty">Empty list</span>;

  const columns = tableColumns(list);
  if (columns) {
    return (
      <div className="json-view__table-wrap">
        <table className="json-view__table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} title={c}>
                  {humanizeKey(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(list as JsonObject[]).map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c}>{c in row ? <JsonInline value={row[c]} /> : null}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (list.every((item) => !isNonEmptyContainer(item))) {
    return (
      <div className="json-view__chips">
        {list.map((item, i) => (
          <span key={i} className="json-view__chip">
            <JsonScalar value={item} />
          </span>
        ))}
      </div>
    );
  }

  // A mixed list: each container item gets its own numbered group.
  return (
    <>
      {list.map((item, i) =>
        isNonEmptyContainer(item) ? (
          <JsonGroup key={i} rawKey={`Item ${i + 1}`} value={item} depth={depth} />
        ) : (
          <dl key={i} className="json-view__sheet">
            <div className="json-view__row">
              <dt className="json-view__label">Item {i + 1}</dt>
              <dd className="json-view__value">
                <JsonScalar value={item} />
              </dd>
            </div>
          </dl>
        ),
      )}
    </>
  );
}

/** A table cell's value: scalars as usual, containers as their summary. */
function JsonInline({ value }: { value: unknown }) {
  if (Array.isArray(value) || isJsonObject(value)) {
    return (
      <span className="json-view__summary" title={JSON.stringify(value, null, 2)}>
        {summarize(value)}
      </span>
    );
  }
  return <JsonScalar value={value} />;
}

function JsonScalar({ value }: { value: unknown }) {
  if (value === null) return <span className="json-view__muted">Not set</span>;
  if (typeof value === "boolean") {
    return (
      <span
        className={"json-view__bool" + (value ? " json-view__bool--yes" : "")}
        title={String(value)}
      >
        {value ? "Yes" : "No"}
      </span>
    );
  }
  if (typeof value === "number") return <span className="json-view__number">{value}</span>;
  if (typeof value === "string") {
    return value === "" ? (
      <span className="json-view__muted">Empty</span>
    ) : (
      <span className="json-view__string">{value}</span>
    );
  }
  // Empty object/array — the only containers that reach here.
  return <span className="json-view__muted">{Array.isArray(value) ? "Empty list" : "No fields"}</span>;
}
