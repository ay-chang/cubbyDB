import { useStore } from "../../state/store";
import type { DependentRowsPreview } from "../../types";

/**
 * Shown instead of the plain `ConfirmDialog` when deleting a row would
 * cascade into other tables via foreign keys — lists what else would go,
 * grouped by table (and nested for dependents-of-dependents), so the user
 * can see the real impact before committing to one action that deletes
 * everything at once. Modeled on how Django's admin panel confirms a
 * cascading delete.
 */
export function DeleteImpactDialog() {
  const dialog = useStore((s) => s.deleteImpactDialog);
  if (!dialog) return null;

  const dependentCount = countRows(dialog.impact.dependents);
  const totalCount = dialog.rootCount + dependentCount;

  return (
    <div className="confirm-overlay" onClick={dialog.onCancel}>
      <div
        className="delete-impact-card"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm cascading delete"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="delete-impact-card__head">
          <span className="delete-impact-card__title">
            Deleting {dialog.rootCount} {dialog.rootCount === 1 ? "row" : "rows"} will also delete{" "}
            {dependentCount} related {dependentCount === 1 ? "row" : "rows"}
          </span>
          <p className="delete-impact-card__subtitle">
            This permanently removes all of the following from the database.
          </p>
        </div>

        <div className="delete-impact-card__list">
          {dialog.impact.dependents.map((dep, i) => (
            <DependentGroupView
              key={`${dep.schema}.${dep.table}.${dep.fkConstraint}-${i}`}
              group={dep}
              depth={0}
            />
          ))}
        </div>

        {dialog.impact.incomplete && (
          <p className="delete-impact-card__warning">
            The real impact may be larger than shown — this stopped early for safety rather than
            examine an unbounded number of rows.
          </p>
        )}

        <div className="confirm-card__actions">
          <button className="btn btn--outline" onClick={dialog.onCancel}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={dialog.onConfirm}>
            Delete {totalCount} {totalCount === 1 ? "row" : "rows"}
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
