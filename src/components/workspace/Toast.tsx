import { useStore } from "../../state/store";

/** Transient bottom-right notice for actions whose outcome is otherwise
 *  invisible from here — chiefly an export that wrote a file elsewhere on
 *  disk. Dismissable, and self-clearing on a timer in the store. */
export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={"toast toast--" + toast.kind} role="status" aria-live="polite">
      <span className="toast__mark" aria-hidden>
        {toast.kind === "success" ? "✓" : "!"}
      </span>
      <span className="toast__msg">{toast.message}</span>
    </div>
  );
}
