import { useStore } from "../../state/store";
import type { DependentRowsPreview } from "../../types";
import { Spinner } from "./Spinner";

/**
 * Confirms deleting rows from the grid. It opens immediately, while the
 * backend is still walking foreign keys (which can take a second or two), so
 * the click visibly registers; Delete stays disabled until that check is in.
 * If the delete would cascade into other tables, it then lists what else
 * would go, grouped by table (and nested for dependents-of-dependents), so
 * the user can see the real impact before committing to one action that
 * deletes everything at once. Modeled on how Django's admin panel confirms a
 * cascading delete.
 */
export function DeleteImpactDialog() {
  const dialog = useStore((s) => s.deleteImpactDialog);
  if (!dialog) return null;

  const { impact, rootCount } = dialog;
  const dependents = impact?.dependents ?? [];
  const dependentCount = countRows(dependents);
  const totalCount = rootCount + dependentCount;
  const rows = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;

  return (
    <div className="confirm-overlay" onClick={dialog.onCancel}>
      <div
        className="delete-impact-card"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm delete"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="delete-impact-card__head">
          <span className="delete-impact-card__title">
            {dependentCount > 0
              ? `Deleting ${rows(rootCount)} will also delete ${dependentCount} related ${
                  dependentCount === 1 ? "row" : "rows"
                }`
              : rootCount === 1
                ? "Delete this row?"
                : `Delete ${rows(rootCount)}?`}
          </span>
          <p className="delete-impact-card__subtitle">
            {dependentCount > 0
              ? "This permanently removes all of the following from the database."
              : `This permanently removes ${rootCount === 1 ? "it" : "them"} from the database.`}
          </p>
        </div>

        {dependents.length > 0 && (
          <div className="delete-impact-card__list">
            {dependents.map((dep, i) => (
              <DependentGroupView
                key={`${dep.schema}.${dep.table}.${dep.fkConstraint}-${i}`}
                group={dep}
                depth={0}
              />
            ))}
          </div>
        )}

        {impact?.incomplete && (
          <p className="delete-impact-card__warning">
            The real impact may be larger than shown — this stopped early for safety rather than
            examine an unbounded number of rows.
          </p>
        )}

        <div className="confirm-card__actions">
          {impact === null && (
            <span className="delete-impact-card__checking">
              <Spinner />
              Checking for related rows…
            </span>
          )}
          <button className="btn btn--outline" onClick={dialog.onCancel}>
            Cancel
          </button>
          <button
            className="btn btn--primary delete-impact-card__confirm"
            onClick={dialog.onConfirm}
            disabled={impact === null}
          >
            {dependentCount > 0 ? `Delete ${rows(totalCount)}` : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function countRows(groups: DependentRowsPreview[]): number {
  let total = 0;
  for (const g of groups) {
    total += g.totalCount;
    total += countRows(g.children);
  }
  return total;
}

function DependentGroupView({ group, depth }: { group: DependentRowsPreview; depth: number }) {
  return (
    <div className="delete-impact-group" style={{ marginLeft: depth * 16 }}>
      <div className="delete-impact-group__head">
        <span className="delete-impact-group__table mono">
          {group.schema}.{group.table}
        </span>
        <span className="delete-impact-group__count">
          {group.totalCount} {group.totalCount === 1 ? "row" : "rows"}
          {group.truncated && " · showing a sample"}
        </span>
      </div>
      {group.sampleRows.length > 0 && (
        <div className="delete-impact-group__sample mono">
          {group.sampleRows.map((row, i) => (
            <div key={i} className="delete-impact-group__row">
              {row
                .slice(0, 4)
                .map((v) => (v == null ? "NULL" : v))
                .join("  ·  ")}
            </div>
          ))}
        </div>
      )}
      {group.children.map((child, i) => (
        <DependentGroupView
          key={`${child.schema}.${child.table}.${child.fkConstraint}-${i}`}
          group={child}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
