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

export interface CurrentConnection {
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

export interface SchemaNode {
  name: string;
  tables: TableNode[];
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

export interface HistoryEntry {
  sql: string;
  connectionName: string | null;
  executedAt: number;
  success: boolean;
  rowCount: number | null;
  elapsedMs: number | null;
  error: string | null;
}
