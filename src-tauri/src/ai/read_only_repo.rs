//! Narrow filesystem capability exposed to AI tools, for repositories the
//! user has attached to a connection.
//!
//! The exact counterpart of `read_only.rs`: it wraps the attached repository
//! list in a type whose only methods read. There is no write, create, delete,
//! or execute method here, so "the assistant cannot modify your code" is a
//! property of what compiles rather than a flag someone can get wrong.
//! Adding a write path would take a deliberate edit to this file.
//!
//! Every path the model supplies is resolved against a canonicalized root and
//! rejected unless it stays inside one. That check is done on the resolved
//! path, after symlinks, so a link pointing out of the repository is refused
//! rather than followed — `../../.ssh/id_rsa` and a symlinked `/etc` are the
//! same class of attempt and both fail.

use std::fs;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use regex::RegexBuilder;

use crate::db::{DbError, DbErrorKind};
use crate::repos::AttachedRepo;

/// Files above this are skipped by search and refused by read: a minified
/// bundle or a checked-in fixture is never what the question was about, and
/// one of them can bury a turn's whole context budget.
const MAX_FILE_BYTES: u64 = 1_000_000;

/// Longest single line echoed back from a search hit. Minified code arrives
/// as one enormous line, and the interesting part is that the file matched.
const MAX_LINE_CHARS: usize = 300;

/// Ceiling on what one search returns, whatever the model asked for.
const MAX_SEARCH_RESULTS: usize = 200;

/// Ceiling on what one listing returns.
const MAX_LIST_RESULTS: usize = 500;

/// Lines returned by a `read_file` with no explicit range.
const DEFAULT_READ_LINES: usize = 400;

/// One line matched by `search_repo`.
pub(crate) struct SearchHit {
    pub repo: String,
    /// Path relative to the repository root — what `read_file` takes back.
    pub path: String,
    pub line: usize,
    pub text: String,
}

pub(crate) struct ReadOnlyRepo {
    repos: Vec<AttachedRepo>,
}

impl ReadOnlyRepo {
    pub(crate) fn new(repos: Vec<AttachedRepo>) -> Self {
        Self { repos }
    }

    pub(crate) fn all(&self) -> &[AttachedRepo] {
        &self.repos
    }

    /// Pick the repository a call is about. A name is only required when more
    /// than one is attached — with a single repository, omitting it is the
    /// obvious reading and the model should not have to be told the name.
    fn pick(&self, name: Option<&str>) -> Result<&AttachedRepo, DbError> {
        match name {
            Some(name) if !name.trim().is_empty() => {
                let wanted = name.trim();
                self.repos
                    .iter()
                    .find(|repo| repo.name.eq_ignore_ascii_case(wanted))
                    .ok_or_else(|| {
                        let known: Vec<&str> =
                            self.repos.iter().map(|r| r.name.as_str()).collect();
                        bad_request(format!(
                            "No attached repository named `{wanted}`. Attached: {}.",
                            known.join(", ")
                        ))
                    })
            }
            _ => match self.repos.as_slice() {
                [only] => Ok(only),
                [] => Err(bad_request(
                    "No repositories are attached to this connection.".to_string(),
                )),
                many => Err(bad_request(format!(
                    "Several repositories are attached — name one of: {}.",
                    many.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")
                ))),
            },
        }
    }

    /// Resolve a model-supplied relative path inside a repository, refusing
    /// anything that escapes it. This is the containment boundary.
    fn resolve(&self, repo: &AttachedRepo, relative: &str) -> Result<PathBuf, DbError> {
        let root = Path::new(&repo.path).canonicalize().map_err(|_| {
            bad_request(format!(
                "`{}` is no longer readable at {}. It may have been moved or deleted.",
                repo.name, repo.path
            ))
        })?;

        let relative = relative.trim().trim_start_matches('/');
        let joined = root.join(relative);
        // Canonicalize resolves `..` and symlinks; the prefix check then sees
        // where the path really landed rather than how it was spelled.
        let resolved = joined
            .canonicalize()
            .map_err(|_| bad_request(format!("{relative} does not exist in `{}`.", repo.name)))?;

        if !resolved.starts_with(&root) {
            return Err(bad_request(format!(
                "{relative} resolves outside `{}`, so it cannot be read.",
                repo.name
            )));
        }
        Ok(resolved)
    }

    /// Read one file, or a line range of it. Returns the text with line
    /// numbers, so the model can cite a location it can search back to.
    pub(crate) fn read_file(
        &self,
        repo_name: Option<&str>,
        relative: &str,
        start_line: Option<usize>,
        end_line: Option<usize>,
    ) -> Result<String, DbError> {
        let repo = self.pick(repo_name)?;
        let path = self.resolve(repo, relative)?;

        let meta = fs::metadata(&path)
            .map_err(|e| bad_request(format!("Could not read {relative}: {e}")))?;
        if meta.is_dir() {
            return Err(bad_request(format!(
                "{relative} is a directory. Use list_repo_files to see what is in it."
            )));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(bad_request(format!(
                "{relative} is {} KB, past the {} KB limit for reading. Use search_repo to find \
                 the relevant lines instead.",
                meta.len() / 1024,
                MAX_FILE_BYTES / 1024
            )));
        }

        let text = fs::read_to_string(&path).map_err(|_| {
            bad_request(format!("{relative} is not a text file, so it cannot be read."))
        })?;

        let lines: Vec<&str> = text.lines().collect();
        let start = start_line.unwrap_or(1).max(1);
        let end = end_line.unwrap_or(start + DEFAULT_READ_LINES - 1).min(lines.len());
        if start > lines.len() {
            return Err(bad_request(format!(
                "{relative} has {} lines; line {start} is past the end.",
                lines.len()
            )));
        }

        let mut out = format!("{} · {relative} (lines {start}-{end} of {})\n", repo.name, lines.len());
        for (offset, line) in lines[start - 1..end].iter().enumerate() {
            out.push_str(&format!("{:>6}  {}\n", start + offset, truncate(line)));
        }
        if end < lines.len() {
            out.push_str(&format!(
                "\n({} more lines — read again with start_line {} to continue.)\n",
                lines.len() - end,
                end + 1
            ));
        }
        Ok(out)
    }

    /// Regex search across one repository, or across every attached one when
    /// no name is given.
    pub(crate) fn search(
        &self,
        repo_name: Option<&str>,
        pattern: &str,
        max_results: usize,
    ) -> Result<Vec<SearchHit>, DbError> {
        if pattern.trim().is_empty() {
            return Err(bad_request("search_repo needs a non-empty pattern.".to_string()));
        }
        // Case-insensitive by default: the model is usually searching for a
        // table or column name whose casing in code it cannot know.
        let regex = RegexBuilder::new(pattern)
            .case_insensitive(true)
            .size_limit(1 << 22)
            .build()
            .map_err(|e| bad_request(format!("`{pattern}` is not a valid regular expression: {e}")))?;

        // A name narrows to one repository; its absence searches all of them,
        // which is the more useful default for "where is this table used".
        let targets: Vec<&AttachedRepo> = match repo_name {
            Some(name) if !name.trim().is_empty() => vec![self.pick(Some(name))?],
            _ => self.repos.iter().collect(),
        };
        if targets.is_empty() {
            return Err(bad_request(
                "No repositories are attached to this connection.".to_string(),
            ));
        }

        let limit = max_results.clamp(1, MAX_SEARCH_RESULTS);
        let mut hits = Vec::new();

        'repos: for repo in targets {
            let root = Path::new(&repo.path);
            for entry in WalkBuilder::new(root).hidden(false).git_ignore(true).build() {
                let Ok(entry) = entry else { continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                    continue;
                }
                // Binary files simply fail to decode, which is the cheapest
                // way to skip them without sniffing content types.
                let Ok(text) = fs::read_to_string(entry.path()) else { continue };
                if !regex.is_match(&text) {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .to_string();
                for (index, line) in text.lines().enumerate() {
                    if regex.is_match(line) {
                        hits.push(SearchHit {
                            repo: repo.name.clone(),
                            path: relative.clone(),
                            line: index + 1,
                            text: truncate(line).trim().to_string(),
                        });
                        if hits.len() >= limit {
                            break 'repos;
                        }
                    }
                }
            }
        }

        Ok(hits)
    }

    /// Paths in a repository, optionally under a subdirectory. The cheap way
    /// for the model to orient itself before searching.
    pub(crate) fn list_files(
        &self,
        repo_name: Option<&str>,
        subdirectory: Option<&str>,
    ) -> Result<Vec<String>, DbError> {
        let repo = self.pick(repo_name)?;
        let root = Path::new(&repo.path).canonicalize().map_err(|_| {
            bad_request(format!("`{}` is no longer readable at {}.", repo.name, repo.path))
        })?;
        let start = match subdirectory.map(str::trim).filter(|s| !s.is_empty()) {
            Some(sub) => self.resolve(repo, sub)?,
            None => root.clone(),
        };

        let mut paths = Vec::new();
        for entry in WalkBuilder::new(&start).hidden(false).git_ignore(true).build() {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            paths.push(
                entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .to_string(),
            );
            if paths.len() >= MAX_LIST_RESULTS {
                break;
            }
        }
        paths.sort();
        Ok(paths)
    }

    /// The compact per-repository layout that goes in the system prompt: the
    /// top two levels of directories, enough to orient the model without
    /// spending the context a full listing would.
    pub(crate) fn outline(&self, repo: &AttachedRepo) -> Vec<String> {
        let Ok(root) = Path::new(&repo.path).canonicalize() else {
            return Vec::new();
        };
        let mut dirs: Vec<String> = Vec::new();
        for entry in WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .max_depth(Some(2))
            .build()
            .flatten()
        {
            if !entry.file_type().is_some_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(relative) = entry.path().strip_prefix(&root) else { continue };
            let relative = relative.to_string_lossy().to_string();
            if !relative.is_empty() {
                dirs.push(relative);
            }
        }
        dirs.sort();
        dirs.truncate(40);
        dirs
    }
}

fn truncate(line: &str) -> String {
    if line.chars().count() > MAX_LINE_CHARS {
        let kept: String = line.chars().take(MAX_LINE_CHARS - 1).collect();
        format!("{kept}…")
    } else {
        line.to_string()
    }
}

/// Tool-argument problems come back as `Query` errors for the same reason the
/// database tools' do: the provider loops report them to the model as a
/// failed tool result it can correct on the next iteration, rather than
/// aborting the whole turn.
fn bad_request(message: String) -> DbError {
    DbError::new(DbErrorKind::Query, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A repository with one file in it, plus a sibling directory holding a
    /// "secret" that nothing inside the repository should be able to reach.
    struct Fixture {
        root: PathBuf,
        repo: AttachedRepo,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("cubbydb_repo_test_{tag}_{nanos}"));
            let repo_dir = root.join("repo");
            fs::create_dir_all(repo_dir.join("src")).unwrap();
            fs::write(
                repo_dir.join("src/orders.ts"),
                "export function cancelOrder(id: string) {\n  // UPDATE public.orders\n}\n",
            )
            .unwrap();
            fs::create_dir_all(root.join("outside")).unwrap();
            fs::write(root.join("outside/secret.txt"), "do not read me\n").unwrap();

            let repo = AttachedRepo {
                id: "r1".to_string(),
                connection_id: "c1".to_string(),
                path: repo_dir.to_string_lossy().to_string(),
                name: "app".to_string(),
                added_at: 0,
            };
            Self { root, repo }
        }

        fn reader(&self) -> ReadOnlyRepo {
            ReadOnlyRepo::new(vec![self.repo.clone()])
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn reads_a_file_inside_the_repository() {
        let fixture = Fixture::new("read");
        let out = fixture.reader().read_file(None, "src/orders.ts", None, None).unwrap();
        assert!(out.contains("cancelOrder"));
        // Line numbers, so the model can cite a location.
        assert!(out.contains("     1  "));
    }

    /// The containment boundary. A traversal that resolves outside the root
    /// must be refused rather than followed — this is the whole reason paths
    /// are canonicalized before the prefix check.
    #[test]
    fn refuses_to_escape_the_repository_with_dot_dot() {
        let fixture = Fixture::new("dotdot");
        let error = fixture
            .reader()
            .read_file(None, "../outside/secret.txt", None, None)
            .expect_err("must not read outside the repository");
        assert!(
            error.message.contains("outside") || error.message.contains("does not exist"),
            "unexpected message: {}",
            error.message
        );
    }

    /// Same boundary, reached through a symlink instead of `..`. Canonicalize
    /// resolves the link, so the prefix check sees where it really points.
    #[cfg(unix)]
    #[test]
    fn refuses_to_follow_a_symlink_out_of_the_repository() {
        let fixture = Fixture::new("symlink");
        let link = Path::new(&fixture.repo.path).join("escape");
        std::os::unix::fs::symlink(fixture.root.join("outside"), &link).unwrap();

        let error = fixture
            .reader()
            .read_file(None, "escape/secret.txt", None, None)
            .expect_err("must not follow a symlink out of the repository");
        assert!(error.message.contains("outside"), "unexpected message: {}", error.message);
    }

    #[test]
    fn search_finds_a_table_name_and_reports_where() {
        let fixture = Fixture::new("search");
        let hits = fixture.reader().search(None, "public\\.orders", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "src/orders.ts");
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].repo, "app");
    }

    #[test]
    fn naming_an_unattached_repository_says_which_ones_exist() {
        let fixture = Fixture::new("badname");
        let error = fixture
            .reader()
            .read_file(Some("nope"), "src/orders.ts", None, None)
            .expect_err("unknown repository must be rejected");
        assert!(error.message.contains("Attached: app"), "unexpected: {}", error.message);
    }

    /// With several repositories attached, a call that names none is
    /// ambiguous and should say so rather than silently pick one.
    #[test]
    fn ambiguous_when_several_are_attached_and_none_is_named() {
        let fixture = Fixture::new("ambiguous");
        let mut second = fixture.repo.clone();
        second.id = "r2".to_string();
        second.name = "web".to_string();
        let reader = ReadOnlyRepo::new(vec![fixture.repo.clone(), second]);

        let error = reader
            .read_file(None, "src/orders.ts", None, None)
            .expect_err("must not guess which repository was meant");
        assert!(error.message.contains("app"), "unexpected: {}", error.message);
        assert!(error.message.contains("web"), "unexpected: {}", error.message);
    }
}

/// Timings for the two things a turn does to an attached repository: the
/// depth-2 outline that goes in every system prompt, and a full search.
///
/// Ignored by default — it measures whatever repository it is pointed at, so
/// it is a probe to run when the numbers matter, not a pass/fail assertion.
/// Run with: `cargo test repo_walk_timings -- --ignored --nocapture`
#[cfg(test)]
mod perf {
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore = "timing probe; run explicitly"]
    fn repo_walk_timings() {
        // This repository by default; point `CUBBYDB_PERF_REPO` at a bigger
        // one to see how the walk scales.
        let root = std::env::var("CUBBYDB_PERF_REPO").unwrap_or_else(|_| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or(Path::new("."))
                .to_string_lossy()
                .to_string()
        });
        let repo = AttachedRepo {
            id: "p".into(),
            connection_id: "c".into(),
            path: root.clone(),
            name: "probe".into(),
            added_at: 0,
        };
        let reader = ReadOnlyRepo::new(vec![repo.clone()]);

        let t = Instant::now();
        let dirs = reader.outline(&repo);
        let outline_ms = t.elapsed().as_millis();

        let t = Instant::now();
        let hits = reader.search(None, "run_read_only_query", 50).unwrap();
        let search_ms = t.elapsed().as_millis();

        println!("repo:        {root}");
        println!("outline:     {outline_ms} ms ({} dirs)", dirs.len());
        println!("full search: {search_ms} ms ({} hits)", hits.len());
    }
}
