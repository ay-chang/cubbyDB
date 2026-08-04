/**
 * Types mirroring the Rust `db` layer (serialized as camelCase). Keep these in
 * sync with `src-tauri/src/db/mod.rs` and the store modules.
 */

export type Engine = "postgres";

export interface ConnectionParams {
  connectionString?: string | null;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  user?: string | null;
  password?: string | null;
}

export interface ConnectionInfo {
  engine: Engine;
  serverVersion: string;
  elapsedMs: number;
}

export interface SavedConnection {
  id: string;
  name: string;
  engine: Engine;
  params: ConnectionParams;
  createdAt: number;
  /** One of `AccentColor`'s names (see state/store.ts), tagging this
   *  connection so it's visually distinguishable — e.g. red for "prod".
   *  `null`/absent means untagged. */
  color?: string | null;
  /** How `color` renders — one of `ConnectionColorStyle`'s values ("border"
   *  or "fill"). `null`/absent falls back to "border". */
  colorStyle?: string | null;
}

/** Returned by `connect` for a newly-opened session — `sessionId` addresses
 *  it in every other session-scoped backend call. Multiple can be live at
 *  once; the frontend tracks one `ConnectionSlot` per session id. */
export interface ActiveConnectionInfo {
  sessionId: string;
  name: string;
  connectionId: string | null;
  info: ConnectionInfo;
}

export interface LastConnection {
  name: string;
  engine: Engine;
  params: ConnectionParams;
}

export type TableKind = "table" | "view";

export interface ForeignKeyRef {
  schema: string;
  table: string;
  column: string;
}

export interface ColumnNode {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  /** Foreign keys this column points at (outgoing). */
  references: ForeignKeyRef[];
  /** Columns in other tables whose FK points at this column (incoming). */
  referencedBy: ForeignKeyRef[];
}

export interface TableNode {
  name: string;
  kind: TableKind;
  estimatedRows: number | null;
  columns: ColumnNode[];
}

export type FunctionKind = "function" | "procedure";

export interface FunctionNode {
  /** `pg_proc.oid` — needed to disambiguate overloads when fetching the
   *  definition (Postgres allows multiple functions with the same name). */
  oid: number;
  name: string;
  /** Display-ready argument list, e.g. `"user_id integer, since timestamptz DEFAULT now()"`. */
  arguments: string;
  /** `null` for procedures, which have no return type. */
  returnType: string | null;
  kind: FunctionKind;
}

export interface SequenceOwner {
  table: string;
  column: string;
}

export interface SequenceNode {
  name: string;
  /** The table/column this sequence is `OWNED BY`, if any — same schema as
   *  the sequence itself. */
  ownedBy: SequenceOwner | null;
}

export interface TypeNode {
  name: string;
  /** Enum values, in their defined display order. */
  values: string[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
  functions: FunctionNode[];
  sequences: SequenceNode[];
  types: TypeNode[];
}

/** A function/procedure's full body — fetched only when its tab is opened. */
export interface FunctionDefinition {
  definition: string;
}

/** A sequence's current value and configuration — fetched only when its tab
 *  is opened. */
export interface SequenceDetails {
  dataType: string;
  startValue: number;
  minValue: number;
  maxValue: number;
  incrementBy: number;
  cycle: boolean;
  cacheSize: number;
  /** `null` until `nextval()` has ever been called on this sequence. */
  lastValue: number | null;
}

export interface ResultColumn {
  name: string;
}

/** Rows in one other table that reference the row(s) about to be deleted,
 *  via one foreign key constraint — shown before a delete that would
 *  otherwise just fail with a raw FK-violation error. */
export interface DependentRowsPreview {
  schema: string;
  table: string;
  fkConstraint: string;
  /** This dependent table's own columns, in the order `sampleRows` uses. */
  columns: string[];
  sampleRows: Array<Array<string | null>>;
  /** The real count — may be larger than `sampleRows.length`. */
  totalCount: number;
  /** True when `totalCount` exceeds the sample shown. */
  truncated: boolean;
  /** Rows that reference *these* dependent rows, one level deeper. */
  children: DependentRowsPreview[];
}

/** Everything that would need to be deleted alongside the row(s) requested,
 *  discovered by walking the foreign-key graph. */
export interface DeleteImpact {
  dependents: DependentRowsPreview[];
  /** True if the walk hit its safety cap before fully resolving — the real
   *  impact may be larger than what's shown. */
  incomplete: boolean;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Array<Array<string | null>>;
  rowCount: number;
  elapsedMs: number;
  commandTag: string | null;
  limitApplied: boolean;
}

export type DbErrorKind =
  | "connection"
  | "query"
  | "notConnected"
  | "internal";

export interface DbError {
  message: string;
  code: string | null;
  hint: string | null;
  position: number | null;
  kind: DbErrorKind;
}

/** One column/value pair: either a row's current value (for a WHERE clause
 * identifying it) or a new value (for a SET clause changing it). `value` is
 * `null` for SQL NULL. */
export interface ColumnValue {
  column: string;
  value: string | null;
}

export interface HistoryEntry {
  sql: string;
  connectionName: string | null;
  executedAt: number;
  success: boolean;
  rowCount: number | null;
  elapsedMs: number | null;
  error: string | null;
}

/** Column, index, and check-constraint details for one table — the "View
 *  structure" panel. Foreign keys aren't included here; they're already
 *  available per-column from the schema tree (`ColumnNode`). */
export interface TableStructure {
  columns: StructureColumn[];
  indexes: IndexDetail[];
  checkConstraints: CheckConstraintDetail[];
}

export interface StructureColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  /** The column's default expression, verbatim from Postgres. `null` means
   *  no default. */
  defaultExpr: string | null;
}

export interface IndexDetail {
  name: string;
  /** The index's own `CREATE INDEX ...` statement. */
  definition: string;
}

export interface CheckConstraintDetail {
  name: string;
  /** The constraint's own `CHECK (...)` text. */
  definition: string;
}

/** A user-saved, named SQL query — distinct from `HistoryEntry` (automatic,
 *  unnamed, one per execution). Global, not tied to a connection. */
export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
}

// --- AI assistant ------------------------------------------------------------
// Anthropic-only, deliberately — see the backend's `ai_config.rs` module doc.

/** What Settings shows for the AI assistant — the real API key never comes
 *  back from the backend once saved, only whether one is set. `model` is
 *  always resolved (the user's saved choice, or the hardcoded fallback), so
 *  there's always a concrete value to show even before one is picked. */
export interface AiConfigStatus {
  anthropicKeySet: boolean;
  anthropicModel: string;
}

/** One model a provider currently offers, for the Settings model picker —
 *  fetched live so a new release shows up without an app update. `label` is
 *  a human-readable name when the provider's API supplies one (Anthropic's
 *  `display_name`); otherwise it's just `id` again (OpenAI's models
 *  endpoint has no display name). */
export interface AiModelInfo {
  id: string;
  label: string;
  /** Whether this model accepts the `effort` request parameter. Not
   *  universal — Haiku 4.5 rejects it — so it's captured when the user picks
   *  a model and persisted with the choice. */
  supportsEffort: boolean;
}

/** One turn of the AI chat. `role`/`content` are exactly what's sent
 *  to/received from the backend on every turn (provider-specific tool-call
 *  scaffolding is entirely a backend-internal concern for a single `aiChat`
 *  call). `trace` is a frontend-only addition, attached to assistant
 *  messages after a reply comes back — the backend's deserializer ignores
 *  unknown fields, so resending a message with `trace` attached is harmless. */
export interface AiMessage {
  role: "user" | "assistant";
  content: string;
  trace?: AiToolTrace[];
}

/** One tool call the AI made to answer a question, shown under its reply so
 *  the user can see exactly what it did rather than trusting a black box. */
export interface AiToolTrace {
  /** Which tool ran — `run_sql`, `describe_table`, `sample_rows`,
   *  `search_schema`, `explain_query`. */
  tool: string;
  /** What it ran on: the SQL for query tools, the table name for
   *  `describe_table`/`sample_rows`, the search term for `search_schema`. */
  detail: string;
  rowCount: number | null;
  error: string | null;
}

export interface AiChatResult {
  reply: string;
  trace: AiToolTrace[];
}

/** A saved chat's lightweight list-view shape — no message bodies, so
 *  listing a connection's chats doesn't ship every message of every one. */
export interface AiChatSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/** A saved chat's full record. Scoped by `connectionId` (a *saved*
 *  connection's stable id) rather than a session id — see the backend's
 *  `ai_chats.rs` module doc for why. */
export interface AiChatThread {
  id: string;
  connectionId: string;
  title: string;
  messages: AiMessage[];
  createdAt: number;
  updatedAt: number;
}
