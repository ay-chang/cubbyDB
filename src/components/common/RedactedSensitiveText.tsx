import { useEffect, useMemo, useState } from "react";

const PLACEHOLDER_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Keep the visual shape of an email while replacing its identifying text.
 *  The placeholder is stable for a given value, preventing layout movement
 *  when it is blurred or revealed. */
function redactedPlaceholder(value: string): string {
  let seed = 17;
  for (const char of value) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return Array.from(value, (char, index) => {
    if ("@.-_".includes(char)) return char;
    const offset = (seed + index * 17 + char.charCodeAt(0) * 13) % PLACEHOLDER_ALPHABET.length;
    return PLACEHOLDER_ALPHABET[offset];
  }).join("");
}

/** Sensitive account text that is obscured by default and revealed only by
 *  an explicit click. Used for the Codex account email in Settings. */
export function RedactedSensitiveText({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  const placeholder = useMemo(() => redactedPlaceholder(value), [value]);

  useEffect(() => {
    setRevealed(false);
  }, [value]);

  return (
    <button
      type="button"
      className={
        "redacted-sensitive mono" +
        (revealed ? " redacted-sensitive--revealed" : " redacted-sensitive--hidden")
      }
      onClick={() => setRevealed((current) => !current)}
      aria-label={revealed ? "Hide account email" : "Reveal account email"}
      title={revealed ? "Click to hide email" : "Click to reveal email"}
    >
      {revealed ? value : placeholder}
    </button>
  );
}
