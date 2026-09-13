//! Tools that read attached code repositories: `search_repo`, `read_file`,
//! and `list_repo_files`.
//!
//! These exist so the assistant can answer "how does the application actually
//! use this table" rather than inferring everything from column names. They
//! are the fallback path — the Claude Code and Codex routes give their own
//! native file tools the same repositories instead, since those are better at
//! it — so these are what the Anthropic and OpenAI API-key routes use, and
//! what keeps repo attachment meaning the same thing on every provider.
//!
//! Every one of them goes through `ReadOnlyRepo`, which has no method that
//! writes. Filesystem work runs on the blocking pool: walking a large
//! repository takes long enough that doing it on a runtime thread would stall
//! every other connection's queries.

use serde_json::Value;

use super::{arg_str, opt_arg_str, ToolContext, ToolOutcome};
use crate::ai::read_only_repo::ReadOnlyRepo;
use crate::ai::ToolTrace;
use crate::db::{DbError, DbErrorKind};

/// Default hits per search when the model doesn't ask for a specific number.
const DEFAULT_SEARCH_RESULTS: usize = 50;

pub async fn search_repo(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let pattern = arg_str(input, "pattern")?;
    let repo = opt_arg_str(input, "repo");
    let max = input
        .get("max_results")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_SEARCH_RESULTS);

    let repos = ctx.repos.all().to_vec();
    let pattern_for_search = pattern.clone();
    let repo_for_search = repo.clone();
    let hits = blocking(move || {
        ReadOnlyRepo::new(repos).search(repo_for_search.as_deref(), &pattern_for_search, max)
    })
    .await?;

    let count = hits.len();
    let content = if hits.is_empty() {
        format!("No matches for `{pattern}`.")
    } else {
        let mut out = format!("{count} match(es) for `{pattern}`:\n");
        let mut current = String::new();
        for hit in &hits {
            let file = format!("{} · {}", hit.repo, hit.path);
            if file != current {
                out.push_str(&format!("\n{file}\n"));
                current = file;
            }
            out.push_str(&format!("{:>6}  {}\n", hit.line, hit.text));
        }
        out.push_str("\nRead any of these with read_file to see the surrounding code.\n");
        out
    };

    Ok(ToolOutcome {
        content,
        trace: ToolTrace {
            tool: "search_repo".to_string(),
            detail: match &repo {
                Some(name) => format!("{pattern} (in {name})"),
                None => pattern,
            },
            row_count: Some(count as i64),
            error: None,
        },
    })
}

pub async fn read_file(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let path = arg_str(input, "path")?;
    let repo = opt_arg_str(input, "repo");
    let start = input.get("start_line").and_then(Value::as_u64).map(|n| n as usize);
    let end = input.get("end_line").and_then(Value::as_u64).map(|n| n as usize);

    let repos = ctx.repos.all().to_vec();
    let path_for_read = path.clone();
    let repo_for_read = repo.clone();
    let content = blocking(move || {
        ReadOnlyRepo::new(repos).read_file(repo_for_read.as_deref(), &path_for_read, start, end)
    })
    .await?;

    Ok(ToolOutcome {
        content,
        trace: ToolTrace {
            tool: "read_file".to_string(),
            detail: match &repo {
                Some(name) => format!("{name} · {path}"),
                None => path,
            },
            row_count: None,
            error: None,
        },
    })
}

pub async fn list_repo_files(ctx: &ToolContext<'_>, input: &Value) -> Result<ToolOutcome, DbError> {
    let repo = opt_arg_str(input, "repo");
    let subdirectory = opt_arg_str(input, "subdirectory");

    let repos = ctx.repos.all().to_vec();
    let repo_for_list = repo.clone();
    let sub_for_list = subdirectory.clone();
    let paths = blocking(move || {
        ReadOnlyRepo::new(repos).list_files(repo_for_list.as_deref(), sub_for_list.as_deref())
    })
    .await?;

    let count = paths.len();
    let content = if paths.is_empty() {
        "No files found.".to_string()
    } else {
        format!("{count} file(s):\n{}", paths.join("\n"))
    };

    Ok(ToolOutcome {
        content,
        trace: ToolTrace {
            tool: "list_repo_files".to_string(),
            detail: match (&repo, &subdirectory) {
                (Some(name), Some(sub)) => format!("{name} · {sub}"),
                (Some(name), None) => name.clone(),
                (None, Some(sub)) => sub.clone(),
                (None, None) => "all files".to_string(),
            },
            row_count: Some(count as i64),
            error: None,
        },
    })
}

/// Runs synchronous filesystem work off the runtime threads. A join failure
/// means the blocking task panicked, which is a bug rather than something the
/// model can recover from, so it surfaces as internal rather than as a
/// correctable tool error.
async fn blocking<T, F>(work: F) -> Result<T, DbError>
where
    F: FnOnce() -> Result<T, DbError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work).await.map_err(|e| {
        DbError::new(DbErrorKind::Internal, format!("Repository read failed: {e}"))
    })?
}
