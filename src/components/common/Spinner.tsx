/** A small indeterminate spinner (accent arc on a hairline ring). */
export function Spinner({ light = false }: { light?: boolean }) {
  return <span className={"spinner" + (light ? " spinner--light" : "")} />;
}
