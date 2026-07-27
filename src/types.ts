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
