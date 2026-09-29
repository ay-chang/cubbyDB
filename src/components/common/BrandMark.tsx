/** The app logo, drawn from the same geometry as the bundled icon
 *  (`app-icon.png`, generated from the handoff's `icon-green.svg`). The slot
 *  is a painted white shape, not a knockout, so the mark reads the same as it
 *  does in the Dock instead of letting whatever is behind it show through.
 *  Sized and colored by `className`. */
export function BrandMark({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden>
      <path
        fill="currentColor"
        d="M28 4h44a24 24 0 0 1 24 24v44a24 24 0 0 1-24 24H28A24 24 0 0 1 4 72V28A24 24 0 0 1 28 4Z"
      />
      <path
        fill="#fff"
        d="M35 36h30a10 10 0 0 1 10 10v8a10 10 0 0 1-10 10H35a10 10 0 0 1-10-10v-8a10 10 0 0 1 10-10Z"
      />
    </svg>
  );
}
