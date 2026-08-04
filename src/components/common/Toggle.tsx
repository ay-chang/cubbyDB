/** Reusable pill toggle switch, used by every on/off setting. */
export function Toggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      className={"toggle" + (on ? " toggle--on" : "")}
      onClick={onToggle}
    >
      <span className="toggle__thumb" />
    </button>
  );
}
