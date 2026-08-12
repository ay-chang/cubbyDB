import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// Flat config (ESLint 9). Kept deliberately small: typescript-eslint's
// non-type-checked "recommended" set (fast — no tsconfig project service)
// plus exactly two rules from eslint-plugin-react-hooks.
//
// Only two, not that plugin's own `recommended` config: as of v7, its
// "recommended" bundles ~15 rules that enforce the constraints the *React
// Compiler* needs (purity, immutability, set-state-in-effect, ...) — a much
// stricter, newer bar than "lint for React hook mistakes," and one this
// codebase doesn't opt into (no React Compiler here). Turning it on wholesale
// flagged dozens of deliberate, correct, and common patterns already used
// throughout this codebase — e.g. `useEffect(() => setX(...), [dep])` to
// reset state when a prop/id changes, which is standard React, not a bug.
// The two rules below are the original, narrowly-scoped pair every React
// project has run for years, and they catch mistakes a type checker
// genuinely cannot see: a hook called conditionally or outside a
// component/hook body (rules-of-hooks), and a `useEffect`/`useCallback`/
// `useMemo` whose dependency array is missing something it reads, which
// silently runs on stale data (exhaustive-deps).
export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (scripts/set-version.mjs) — Node globals, no
    // React/TS-specific rules.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // tsc (`npm run build`) already catches unused locals/params with the
      // full type-checker's context (`noUnusedLocals`/`noUnusedParameters` in
      // tsconfig.json) — duplicating that here without type info would just
      // produce a noisier, less accurate second opinion.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
