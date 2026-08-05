//! Conservative SQL gate for model-generated database reads.
//!
//! This is intentionally an allowlist, not an attempt to understand all of
//! PostgreSQL. The server-side `READ ONLY` transaction remains the authority;
//! this gate rejects obviously unsafe input before it reaches that boundary.

use super::{DbError, DbErrorKind};

const ALLOWED_LEADING_WORDS: &[&str] = &["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN"];

const FORBIDDEN_WORDS: &[&str] = &[
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "COPY",
    "CALL",
    "DO",
    "GRANT",
    "REVOKE",
    "COMMENT",
    "VACUUM",
    "REINDEX",
    "CLUSTER",
    "REFRESH",
    "DISCARD",
    "LISTEN",
    "UNLISTEN",
    "NOTIFY",
    "LOAD",
    "IMPORT",
    "REASSIGN",
    "SET",
    "RESET",
    "LOCK",
    "PREPARE",
    "EXECUTE",
    "DEALLOCATE",
    "DECLARE",
    "FETCH",
    "MOVE",
    "CLOSE",
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "CHECKPOINT",
    "INTO",
];

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Word(String),
    Semicolon,
    Other,
}

/// Accept exactly one SELECT-family statement and reject every known
/// PostgreSQL write, DDL, transaction, session, and administrative command.
/// Quoted strings, identifiers, comments, and dollar-quoted bodies are not
/// interpreted as commands.
pub(crate) fn validate_read_only_statement(sql: &str) -> Result<(), DbError> {
    let tokens = lex_significant_tokens(sql);
    let first_word = tokens.iter().find_map(|token| match token {
        Token::Word(word) => Some(word.as_str()),
        Token::Semicolon | Token::Other => None,
    });

    if !first_word.is_some_and(|word| ALLOWED_LEADING_WORDS.contains(&word)) {
        return Err(read_only_error());
    }

    if tokens
        .iter()
        .any(|token| matches!(token, Token::Word(word) if FORBIDDEN_WORDS.contains(&word.as_str())))
    {
        return Err(read_only_error());
    }

    let semicolons = tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| **token == Token::Semicolon)
        .collect::<Vec<_>>();
    if semicolons.len() > 1
        || semicolons
            .first()
            .is_some_and(|(index, _)| *index + 1 != tokens.len())
    {
        return Err(read_only_error());
    }

    Ok(())
}

fn read_only_error() -> DbError {
    DbError::new(
        DbErrorKind::Query,
        "Ask AI can only execute one read-only SELECT-family statement.",
    )
}

fn lex_significant_tokens(sql: &str) -> Vec<Token> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            byte if byte.is_ascii_whitespace() => index += 1,
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2);
            }
            b'\'' => index = skip_quoted(bytes, index + 1, b'\''),
            b'"' => index = skip_quoted(bytes, index + 1, b'"'),
            b'$' => {
                if let Some(delimiter) = dollar_quote_delimiter(bytes, index) {
                    index = skip_dollar_quote(bytes, index + delimiter.len(), delimiter);
                } else {
                    tokens.push(Token::Other);
                    index += 1;
                }
            }
            b';' => {
                tokens.push(Token::Semicolon);
                index += 1;
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric()
                        || bytes[index] == b'_'
                        || bytes[index] == b'$')
                {
                    index += 1;
                }
                tokens.push(Token::Word(sql[start..index].to_ascii_uppercase()));
            }
            _ => {
                tokens.push(Token::Other);
                index += 1;
            }
        }
    }

    tokens
}

fn skip_quoted(bytes: &[u8], mut index: usize, quote: u8) -> usize {
    while index < bytes.len() {
        if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
            } else {
                return index + 1;
            }
        } else {
            index += 1;
        }
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> usize {
    let mut depth = 1_u32;
    while index < bytes.len() && depth > 0 {
        if bytes.get(index..index + 2) == Some(b"/*") {
            depth += 1;
            index += 2;
        } else if bytes.get(index..index + 2) == Some(b"*/") {
            depth -= 1;
            index += 2;
        } else {
            index += 1;
        }
    }
    index
}

fn dollar_quote_delimiter(bytes: &[u8], start: usize) -> Option<&[u8]> {
    let mut index = start + 1;
    while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') {
        index += 1;
    }
    (bytes.get(index) == Some(&b'$')).then(|| &bytes[start..=index])
}

fn skip_dollar_quote(bytes: &[u8], mut index: usize, delimiter: &[u8]) -> usize {
    while index + delimiter.len() <= bytes.len() {
        if &bytes[index..index + delimiter.len()] == delimiter {
            return index + delimiter.len();
        }
        index += 1;
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_select_family_queries() {
        for sql in [
            "SELECT * FROM public.users LIMIT 10",
            "WITH recent AS (SELECT * FROM events) SELECT * FROM recent;",
            "VALUES (1), (2)",
            "TABLE public.users",
            "SHOW server_version",
            "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM public.users",
        ] {
            assert!(validate_read_only_statement(sql).is_ok(), "{sql}");
        }
    }

    #[test]
    fn ignores_command_words_in_quoted_content_and_comments() {
        for sql in [
            "SELECT 'DELETE FROM users'",
            "SELECT \"update\" FROM public.words",
            "SELECT $$DROP TABLE users$$",
            "SELECT 1 /* DELETE; nested /* UPDATE */ safe */; -- INSERT",
        ] {
            assert!(validate_read_only_statement(sql).is_ok(), "{sql}");
        }
    }

    #[test]
    fn rejects_writes_ddl_and_modifying_ctes() {
        for sql in [
            "INSERT INTO users(name) VALUES ('Ada')",
            "UPDATE users SET admin = true",
            "DELETE FROM users",
            "DROP TABLE users",
            "WITH removed AS (DELETE FROM users RETURNING *) SELECT * FROM removed",
            "SELECT * INTO archived_users FROM users",
            "EXPLAIN ANALYZE UPDATE users SET admin = true",
        ] {
            assert!(validate_read_only_statement(sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn rejects_multiple_statements_and_non_query_prefixes() {
        for sql in [
            "SELECT 1; SELECT 2",
            "SELECT 1;;",
            "SELECT 1; 2",
            "",
            "SET search_path = public",
        ] {
            assert!(validate_read_only_statement(sql).is_err(), "{sql}");
        }
    }
}
