//! Narrow database capability exposed to AI tools.
//!
//! Keeping the general `DbSession` private here makes write methods
//! unavailable to the tool dispatcher at compile time. Adding an AI write
//! path therefore requires an explicit change to this wrapper, not merely a
//! mistaken call to `update_row`, `insert_row`, or `delete_row` in a tool.

use crate::db::{DbError, DbSession, QueryResult, TableStructure};

pub(crate) struct ReadOnlyDb<'a> {
    session: &'a dyn DbSession,
}

impl<'a> ReadOnlyDb<'a> {
    pub(crate) fn new(session: &'a dyn DbSession) -> Self {
        Self { session }
    }

    pub(crate) async fn run_query(&self, sql: &str) -> Result<QueryResult, DbError> {
        self.session
            .run_read_only_query(sql, Some(crate::db::AI_ROW_LIMIT))
            .await
    }

    pub(crate) async fn table_structure(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<TableStructure, DbError> {
        self.session.table_structure(schema, table).await
    }

    pub(crate) fn select_top_sql(&self, schema: &str, table: &str, limit: u32) -> String {
        self.session
            .select_top_sql(schema, table, None, limit, 0, None)
    }
}
