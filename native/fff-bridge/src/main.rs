use anyhow::{Context, Result, anyhow};
use fff_core::file_picker::FilePicker;
use fff_core::grep::{GrepMode, GrepSearchOptions, grep_search, parse_grep_query};
use fff_core::types::FileItem;
use fff_core::{
    FFFMode, FuzzySearchOptions, PaginationArgs, QueryParser, SharedFrecency, SharedPicker,
};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::sync::{Arc, RwLock};

const MAX_GREP_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LINE_MATCHES_PER_FILE: usize = 3;
const GREP_TIME_BUDGET_MS: u64 = 75;
const DEFAULT_COMBO_BOOST_MULTIPLIER: i32 = 100;
const DEFAULT_MIN_COMBO_COUNT: u32 = 3;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Request {
    Init {
        id: u64,
        roots: Vec<String>,
    },
    Search {
        id: u64,
        query: String,
        limit: usize,
        #[serde(rename = "currentFile")]
        current_file: Option<String>,
    },
    Rescan {
        id: u64,
    },
    Shutdown {
        id: u64,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Response {
    Ready {
        id: u64,
    },
    Ack {
        id: u64,
    },
    Results {
        id: u64,
        results: Vec<SearchHit>,
        #[serde(rename = "indexedFileCount")]
        indexed_file_count: usize,
        #[serde(rename = "searchableFileCount")]
        searchable_file_count: usize,
        #[serde(rename = "skippedFileCount")]
        skipped_file_count: usize,
        #[serde(rename = "isScanning")]
        is_scanning: bool,
    },
    Error {
        id: Option<u64>,
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SearchHit {
    File {
        path: String,
        score: f64,
    },
    Line {
        path: String,
        score: f64,
        #[serde(rename = "lineNumber")]
        line_number: u64,
        column: usize,
        #[serde(rename = "lineText")]
        line_text: String,
    },
}

#[derive(Debug)]
struct RootState {
    picker: SharedPicker,
    frecency: SharedFrecency,
}

#[derive(Debug, Default)]
struct SearchPayload {
    results: Vec<SearchHit>,
    indexed_file_count: usize,
    searchable_file_count: usize,
    skipped_file_count: usize,
    is_scanning: bool,
}

#[derive(Debug, Default)]
struct App {
    roots: Vec<RootState>,
}

#[derive(Debug)]
struct FileCandidate {
    path: String,
}

#[derive(Debug)]
struct LineCandidate {
    path: String,
    line_number: u64,
    column: usize,
    line_text: String,
}

#[derive(Debug)]
enum MergedCandidate {
    File(FileCandidate),
    Line(LineCandidate),
}

impl App {
    fn initialize(&mut self, roots: Vec<String>) -> Result<()> {
        self.shutdown();

        let next_roots = roots
            .into_iter()
            .map(RootState::new)
            .collect::<Result<Vec<_>>>()?;
        self.roots = next_roots;
        Ok(())
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
        current_file: Option<&str>,
    ) -> Result<SearchPayload> {
        if self.roots.is_empty() {
            return Err(anyhow!("fff sidecar is not initialized"));
        }

        let mut payload = SearchPayload::default();
        let mut file_candidates = Vec::new();
        let mut line_candidates = Vec::new();

        for root in &self.roots {
            let picker_guard = root
                .picker
                .read()
                .map_err(|_| anyhow!("Failed to acquire file picker lock"))?;
            let picker = picker_guard
                .as_ref()
                .context("File picker not initialized for workspace root")?;
            let files = picker.get_files();

            payload.indexed_file_count += files.len();
            payload.searchable_file_count +=
                files.iter().filter(|file| is_searchable(file)).count();
            payload.is_scanning |= picker.is_scan_active();

            let parsed_query = QueryParser::default().parse(query);
            let file_results = FilePicker::fuzzy_search(
                files,
                query,
                parsed_query,
                FuzzySearchOptions {
                    max_threads: 0,
                    current_file,
                    project_path: Some(picker.base_path()),
                    last_same_query_match: None,
                    combo_boost_score_multiplier: DEFAULT_COMBO_BOOST_MULTIPLIER,
                    min_combo_count: DEFAULT_MIN_COMBO_COUNT,
                    pagination: PaginationArgs { offset: 0, limit },
                },
            );

            file_candidates.extend(file_results.items.into_iter().map(|item| FileCandidate {
                path: item.path.to_string_lossy().into_owned(),
            }));

            if !query.trim().is_empty() {
                let grep_query = parse_grep_query(query);
                let grep_results = grep_search(
                    files,
                    query,
                    grep_query.as_ref(),
                    &grep_options(query, limit),
                );

                for grep_match in grep_results.matches {
                    let file = grep_results.files[grep_match.file_index];
                    line_candidates.push(LineCandidate {
                        path: file.path.to_string_lossy().into_owned(),
                        line_number: grep_match.line_number,
                        column: byte_column_to_utf16_column(
                            &grep_match.line_content,
                            grep_match.col,
                        ),
                        line_text: grep_match.line_content,
                    });
                }
            }
        }

        payload.skipped_file_count = payload
            .indexed_file_count
            .saturating_sub(payload.searchable_file_count);
        payload.results = blend_results(file_candidates, line_candidates, limit);

        Ok(payload)
    }

    fn rescan(&mut self) -> Result<()> {
        for root in &mut self.roots {
            let mut picker_guard = root
                .picker
                .write()
                .map_err(|_| anyhow!("Failed to acquire file picker lock"))?;
            let picker = picker_guard
                .as_mut()
                .context("File picker not initialized for workspace root")?;
            picker
                .trigger_rescan(&root.frecency)
                .context("Failed to trigger fff rescan")?;
        }

        Ok(())
    }

    fn shutdown(&mut self) {
        for root in &mut self.roots {
            if let Ok(mut picker_guard) = root.picker.write()
                && let Some(mut picker) = picker_guard.take()
            {
                picker.stop_background_monitor();
            }

            if let Ok(mut frecency_guard) = root.frecency.write() {
                *frecency_guard = None;
            }
        }

        self.roots.clear();
    }
}

impl RootState {
    fn new(root: String) -> Result<Self> {
        let picker: SharedPicker = Arc::new(RwLock::new(None));
        let frecency: SharedFrecency = Arc::new(RwLock::new(None));

        FilePicker::new_with_shared_state(
            root.clone(),
            false,
            FFFMode::Neovim,
            Arc::clone(&picker),
            Arc::clone(&frecency),
        )
        .with_context(|| format!("Failed to initialize fff for workspace root {root}"))?;

        Ok(Self { picker, frecency })
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut app = App::default();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) if !line.trim().is_empty() => line,
            Ok(_) => continue,
            Err(error) => {
                write_response(
                    &mut output,
                    &Response::Error {
                        id: None,
                        message: format!("Failed to read request: {error}"),
                    },
                )?;
                continue;
            }
        };

        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut output,
                    &Response::Error {
                        id: None,
                        message: format!("Failed to parse request: {error}"),
                    },
                )?;
                continue;
            }
        };

        let shutdown_after_response = matches!(request, Request::Shutdown { .. });

        let response = match request {
            Request::Init { id, roots } => match app.initialize(roots) {
                Ok(()) => Response::Ready { id },
                Err(error) => Response::Error {
                    id: Some(id),
                    message: error.to_string(),
                },
            },
            Request::Search {
                id,
                query,
                limit,
                current_file,
            } => match app.search(&query, limit.max(1), current_file.as_deref()) {
                Ok(payload) => Response::Results {
                    id,
                    results: payload.results,
                    indexed_file_count: payload.indexed_file_count,
                    searchable_file_count: payload.searchable_file_count,
                    skipped_file_count: payload.skipped_file_count,
                    is_scanning: payload.is_scanning,
                },
                Err(error) => Response::Error {
                    id: Some(id),
                    message: error.to_string(),
                },
            },
            Request::Rescan { id } => match app.rescan() {
                Ok(()) => Response::Ack { id },
                Err(error) => Response::Error {
                    id: Some(id),
                    message: error.to_string(),
                },
            },
            Request::Shutdown { id } => {
                app.shutdown();
                Response::Ack { id }
            }
        };

        write_response(&mut output, &response)?;

        if shutdown_after_response {
            break;
        }
    }

    app.shutdown();
    Ok(())
}

fn write_response(writer: &mut dyn Write, response: &Response) -> Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn grep_options(_query: &str, limit: usize) -> GrepSearchOptions {
    GrepSearchOptions {
        max_file_size: MAX_GREP_FILE_SIZE_BYTES,
        max_matches_per_file: MAX_LINE_MATCHES_PER_FILE,
        smart_case: true,
        file_offset: 0,
        page_limit: limit,
        mode: grep_mode(),
        time_budget_ms: GREP_TIME_BUDGET_MS,
        before_context: 0,
        after_context: 0,
        classify_definitions: false,
    }
}

fn grep_mode() -> GrepMode {
    GrepMode::PlainText
}

fn is_searchable(file: &FileItem) -> bool {
    !file.is_binary && file.size <= MAX_GREP_FILE_SIZE_BYTES
}

fn blend_results(
    file_candidates: Vec<FileCandidate>,
    line_candidates: Vec<LineCandidate>,
    limit: usize,
) -> Vec<SearchHit> {
    let mut merged = Vec::with_capacity(limit);
    merged.extend(line_candidates.into_iter().map(MergedCandidate::Line));
    merged.extend(file_candidates.into_iter().map(MergedCandidate::File));

    let total = merged.len().max(1);
    merged
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, candidate)| {
            let score = (total - index) as f64;
            match candidate {
                MergedCandidate::File(candidate) => SearchHit::File {
                    path: candidate.path,
                    score,
                },
                MergedCandidate::Line(candidate) => SearchHit::Line {
                    path: candidate.path,
                    score,
                    line_number: candidate.line_number,
                    column: candidate.column,
                    line_text: candidate.line_text,
                },
            }
        })
        .collect()
}

fn byte_column_to_utf16_column(line: &str, byte_column: usize) -> usize {
    let mut safe_boundary = byte_column.min(line.len());
    while safe_boundary > 0 && !line.is_char_boundary(safe_boundary) {
        safe_boundary -= 1;
    }

    line[..safe_boundary].encode_utf16().count() + 1
}

#[cfg(test)]
mod tests {
    use super::{FileCandidate, LineCandidate, Request, Response, SearchHit, blend_results};

    #[test]
    fn blends_line_results_before_file_results() {
        let results = blend_results(
            vec![
                FileCandidate {
                    path: "a.ts".into(),
                },
                FileCandidate {
                    path: "b.ts".into(),
                },
            ],
            vec![LineCandidate {
                path: "c.ts".into(),
                line_number: 12,
                column: 4,
                line_text: "match".into(),
            }],
            3,
        );

        assert_eq!(results.len(), 3);
        assert!(matches!(results[0], super::SearchHit::Line { .. }));
        assert!(matches!(results[1], super::SearchHit::File { .. }));
        assert!(matches!(results[2], super::SearchHit::File { .. }));
    }

    #[test]
    fn serializes_results_in_camel_case() {
        let response = Response::Results {
            id: 1,
            results: vec![SearchHit::Line {
                path: "src/main.ts".into(),
                score: 3.0,
                line_number: 14,
                column: 2,
                line_text: "const value = 1".into(),
            }],
            indexed_file_count: 10,
            searchable_file_count: 8,
            skipped_file_count: 2,
            is_scanning: false,
        };

        let json = serde_json::to_value(response).expect("response should serialize");
        assert_eq!(json["type"], "results");
        assert_eq!(json["indexedFileCount"], 10);
        assert_eq!(json["searchableFileCount"], 8);
        assert_eq!(json["skippedFileCount"], 2);
        assert_eq!(json["isScanning"], false);
        assert_eq!(json["results"][0]["lineNumber"], 14);
        assert_eq!(json["results"][0]["lineText"], "const value = 1");
    }

    #[test]
    fn parses_current_file_in_camel_case() {
        let request = serde_json::from_str::<Request>(
            r#"{"id":1,"type":"search","query":"abc","limit":20,"currentFile":"/tmp/x.ts"}"#,
        )
        .expect("request should parse");

        match request {
            Request::Search { current_file, .. } => {
                assert_eq!(current_file.as_deref(), Some("/tmp/x.ts"));
            }
            other => panic!("unexpected request: {other:?}"),
        }
    }
}
