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
  /** When true, every mutation on this connection is refused before it
   *  reaches the database, and running SQL is restricted to a single
   *  SELECT-family statement inside a rolled-back READ ONLY transaction —
   *  a safety net independent of whatever the database role itself
   *  actually grants. */
  readOnly?: boolean;
  /** SSH bastion to tunnel the Postgres connection through — `host`/`port`
   *  above are the *real* database, as reachable from that bastion, not
   *  necessarily from this machine directly. `null`/absent means no
   *  tunnel, same as `enabled: false`. */
  ssh?: SshTunnelParams | null;
}

/** How to authenticate to an SSH bastion. A tagged union (not three
 *  optional fields) so the form's auth-method selector always maps onto
 *  exactly one of these, with no way to have e.g. a password and a private
 *  key both set at once. */
export type SshAuthMethod =
  | { method: "password"; password?: string | null }
  | {
      method: "privateKey";
      /** The key's own contents, not a path to it on disk — see
       *  `pickAndReadTextFile` in `api/backend.ts` for why: this has to
       *  survive the saved connection being opened on a different machine,
       *  which a path can't promise. */
      keyContents?: string | null;
      passphrase?: string | null;
    }
  | { method: "agent" };

export interface SshTunnelParams {
  enabled: boolean;
  bastionHost?: string | null;
  bastionPort: number;
  bastionUser?: string | null;
  auth: SshAuthMethod;
}

/** What `probeSshHostKey` reports about a bastion's host key, for the SSH
 *  tunnel form's trust-on-first-use confirmation UI. */
export type SshHostKeyStatus =
  | { status: "unknown" }
  | { status: "trusted" }
  | { status: "changed"; previousFingerprint: string };

export interface SshHostKeyProbe {
  fingerprint: string;
  keyType: string;
  status: SshHostKeyStatus;
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
  /** The saved connection this came from, if any — carried through launch's
   *  auto-reconnect so it comes back up linked to its saved record (and its
   *  color) instead of as an unlinked ad-hoc session. `null`/absent for a
   *  connection that was never saved. */
  id?: string | null;
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
  /** The result is capped and the rest isn't reachable by paging — the
   *  statement carries its own LIMIT. Raises the "LIMIT APPLIED" badge. */
  limitApplied: boolean;
  /** The driver appended LIMIT/OFFSET itself, so this is one page of a larger
   *  result and the pager applies. */
  paged: boolean;
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
  triggers: TriggerDetail[];
  /** Whether Row-Level Security is turned on for this table at all,
   *  independent of whether any policies exist — `true` with an empty
   *  `rlsPolicies` means every role but the table owner is denied by
   *  default. */
  rlsEnabled: boolean;
  rlsPolicies: RlsPolicyDetail[];
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

export interface TriggerDetail {
  name: string;
  /** The trigger's own `CREATE TRIGGER ...` statement. */
  definition: string;
}

export interface RlsPolicyDetail {
  name: string;
  /** `"PERMISSIVE"` or `"RESTRICTIVE"`, verbatim from Postgres. */
  permissive: string;
  /** `"ALL"`, `"SELECT"`, `"INSERT"`, `"UPDATE"`, or `"DELETE"`. */
  command: string;
  roles: string[];
  usingExpr: string | null;
  checkExpr: string | null;
}

// --- Schema Compare ---------------------------------------------------

/** One schema's ordinary base tables, with named PK/unique/FK constraints —
 *  richer than `TableStructure`, needed to generate DDL from. Used only by
 *  Schema Compare. */
export interface SchemaSnapshot {
  schema: string;
  tables: TableSnapshot[];
}

export interface TableSnapshot {
  name: string;
  columns: ColumnSnapshot[];
  primaryKey: NamedKeySnapshot | null;
  uniqueConstraints: NamedKeySnapshot[];
  foreignKeys: ForeignKeySnapshot[];
  indexes: IndexDetail[];
  checkConstraints: CheckConstraintDetail[];
}

export interface ColumnSnapshot {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultExpr: string | null;
}

/** A named `PRIMARY KEY` or `UNIQUE` constraint and the columns it covers. */
export interface NamedKeySnapshot {
  name: string;
  columns: string[];
}

export type FkAction = "noAction" | "restrict" | "cascade" | "setNull" | "setDefault";

export interface ForeignKeySnapshot {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: FkAction;
  onDelete: FkAction;
}

export type ChangeKind = "added" | "removed" | "changed";

export interface ColumnDiff {
  name: string;
  kind: ChangeKind;
  before: ColumnSnapshot | null;
  after: ColumnSnapshot | null;
}

export interface PrimaryKeyDiff {
  kind: ChangeKind;
  before: NamedKeySnapshot | null;
  after: NamedKeySnapshot | null;
}

export interface UniqueConstraintDiff {
  name: string;
  kind: ChangeKind;
  before: NamedKeySnapshot | null;
  after: NamedKeySnapshot | null;
}

export interface ForeignKeyDiff {
  name: string;
  kind: ChangeKind;
  before: ForeignKeySnapshot | null;
  after: ForeignKeySnapshot | null;
}

export interface IndexDiff {
  name: string;
  kind: ChangeKind;
  before: IndexDetail | null;
  after: IndexDetail | null;
}

export interface CheckConstraintDiff {
  name: string;
  kind: ChangeKind;
  before: CheckConstraintDetail | null;
  after: CheckConstraintDetail | null;
}

export interface TableDiff {
  name: string;
  kind: ChangeKind;
  columns: ColumnDiff[];
  primaryKey: PrimaryKeyDiff | null;
  uniqueConstraints: UniqueConstraintDiff[];
  foreignKeys: ForeignKeyDiff[];
  indexes: IndexDiff[];
  checkConstraints: CheckConstraintDiff[];
}

/** Only tables with at least one change — two identical schemas produce an
 *  empty `tables` list. */
export interface SchemaDiff {
  tables: TableDiff[];
}

export interface MigrationScript {
  sql: string;
  statementCount: number;
}

export interface SchemaCompareResult {
  diff: SchemaDiff;
  migration: MigrationScript;
}

/** A user-saved, named SQL query — distinct from `HistoryEntry` (automatic,
 *  unnamed, one per execution). Global, not tied to a connection. */
export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
}

// --- Cubbies -------------------------------------------------------------
// A cubby is a named collection of *references* to things spread across the
// app — never a copy of their contents. See `src-tauri/src/cubbies.rs` for
// the full reasoning (non-exclusive membership, reference-only, scoped to
// one connection).

export type CubbyEntry =
  | { kind: "savedQuery"; savedQueryId: string }
  | { kind: "table"; schema: string; table: string }
  | { kind: "chat"; chatId: string }
  | { kind: "structure"; schema: string; table: string }
  | { kind: "function"; schema: string; name: string; oid: number | null }
  | { kind: "sequence"; schema: string; name: string };

/** A user-created cubby — scoped to one *saved* connection (`connectionId`,
 *  a saved connection's stable id, same reasoning as `AiChatThread`), since
 *  most of what it can hold (tables, chats) only makes sense against a
 *  specific database. */
export interface Cubby {
  id: string;
  name: string;
  connectionId: string;
  entries: CubbyEntry[];
  createdAt: number;
  updatedAt: number;
}

// --- AI assistant ------------------------------------------------------------

export type AiProvider = "anthropic" | "openai" | "codex" | "claudeCode";
export type AiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** What Settings shows for the AI assistant — the real API key never comes
 *  back from the backend once saved. Key hints contain only a known provider
 *  prefix and four trailing characters. `model` is always resolved (the
 *  user's saved choice, or the hardcoded fallback), so there's always a
 *  concrete value to show even before one is picked. */
export interface AiConfigStatus {
  provider: AiProvider;
  anthropicKeySet: boolean;
  anthropicKeyHint: string | null;
  anthropicModel: string;
  openaiKeySet: boolean;
  openaiKeyHint: string | null;
  openaiModel: string;
  openaiReasoningEffort: AiReasoningEffort;
  codexModel: string;
  codexReasoningEffort: AiReasoningEffort;
  codexInstalled: boolean;
  codexAuthenticated: boolean;
  codexEmail: string | null;
  codexPlanType: string | null;
  codexVersion: string | null;
  codexError: string | null;
  claudeCodeModel: string;
  claudeCodeReasoningEffort: AiReasoningEffort;
  claudeCodeInstalled: boolean;
  claudeCodeAuthenticated: boolean;
  claudeCodeEmail: string | null;
  claudeCodePlanType: string | null;
  claudeCodeVersion: string | null;
  claudeCodeError: string | null;
  /** Whether the user has accepted the current AI-provider terms at
   *  cubbydb.com/terms — gates the Codex/Claude Code sign-in buttons. */
  termsAccepted: boolean;
}

/** One model the active provider currently offers, for the Settings model picker —
 *  fetched live so a new release shows up without an app update. `label` is
 *  a human-readable name when the provider's API supplies one (Anthropic's
 *  `display_name`); otherwise it's just `id` again (OpenAI's models
 *  endpoint has no display name). */
export interface AiModelInfo {
  id: string;
  label: string;
  /** Whether this model accepts its provider's reasoning-effort parameter. */
  supportsEffort: boolean;
  supportedReasoningEfforts: AiReasoningEffort[];
  defaultReasoningEffort: AiReasoningEffort | null;
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

/** What the filter bar's AI mode gets back: the predicate to drop in after
 *  `WHERE`, and an optional one-line note for what the predicate itself
 *  can't carry — an assumption the AI made, or (with an empty
 *  `whereClause`) why the request couldn't be turned into a filter. */
export interface AiFilterResult {
  whereClause: string;
  note: string | null;
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
