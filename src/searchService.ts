import * as path from 'path';
import * as vscode from 'vscode';
import { SearchResponse, SearchResult, SearchResultPreview } from './searchTypes';

const EXCLUDE_GLOB = '**/{.git,node_modules,dist,out,build,.next,coverage,.turbo,target}/**';
const MAX_FILES = 3000;
const MAX_FILE_SIZE_BYTES = 256 * 1024;
const MAX_TOTAL_INDEX_BYTES = 24 * 1024 * 1024;
const DEFAULT_RESULT_LIMIT = 80;
const MAX_LINE_MATCHES_PER_FILE = 3;
const PREVIEW_CONTEXT_RADIUS = 3;

interface IndexedFile {
	uri: vscode.Uri;
	relativePath: string;
	pathKey: string;
	baseName: string;
	lines?: string[];
	skipReason?: 'binary' | 'tooLarge' | 'budget';
}

interface NormalizedQuery {
	raw: string;
	trimmed: string;
	compact: string;
	terms: string[];
}

interface FuzzyScore {
	score: number;
	firstMatchIndex: number;
}

export class SearchService implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly decoder = new TextDecoder('utf-8');
	private indexPromise?: Promise<void>;
	private files: IndexedFile[] = [];
	private indexedFileCount = 0;
	private searchableFileCount = 0;
	private skippedFileCount = 0;
	private stale = true;

	constructor() {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		this.disposables.push(
			watcher,
			watcher.onDidCreate(() => this.invalidate()),
			watcher.onDidChange(() => this.invalidate()),
			watcher.onDidDelete(() => this.invalidate())
		);
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	public async search(query: string, resultLimit = DEFAULT_RESULT_LIMIT): Promise<SearchResponse> {
		const startedAt = Date.now();
		await this.ensureIndexed();

		const normalized = normalizeQuery(query);
		const results = normalized.compact
			? this.searchWithQuery(normalized, resultLimit)
			: this.defaultResults(resultLimit);

		return {
			query,
			results,
			indexedFileCount: this.indexedFileCount,
			searchableFileCount: this.searchableFileCount,
			skippedFileCount: this.skippedFileCount,
			durationMs: Date.now() - startedAt
		};
	}

	private async ensureIndexed(): Promise<void> {
		if (!vscode.workspace.workspaceFolders?.length) {
			throw new Error('Open a folder or workspace before using Modal Find.');
		}

		if (!this.stale && this.indexPromise) {
			return this.indexPromise;
		}

		this.indexPromise = this.buildIndex();
		this.stale = false;
		return this.indexPromise;
	}

	private invalidate(): void {
		this.stale = true;
	}

	private async buildIndex(): Promise<void> {
		const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_FILES);
		const indexedFiles: IndexedFile[] = [];
		let totalIndexedBytes = 0;

		for (const uri of uris) {
			const relativePath = vscode.workspace.asRelativePath(uri, true);
			const pathKey = relativePath.toLowerCase();
			const baseName = path.basename(relativePath).toLowerCase();

			let indexedFile: IndexedFile = {
				uri,
				relativePath,
				pathKey,
				baseName
			};

			try {
				const stat = await vscode.workspace.fs.stat(uri);

				if (stat.size > MAX_FILE_SIZE_BYTES) {
					indexedFile = {
						...indexedFile,
						skipReason: 'tooLarge'
					};
				} else if (totalIndexedBytes >= MAX_TOTAL_INDEX_BYTES) {
					indexedFile = {
						...indexedFile,
						skipReason: 'budget'
					};
				} else {
					const bytes = await vscode.workspace.fs.readFile(uri);
					if (isProbablyBinary(bytes)) {
						indexedFile = {
							...indexedFile,
							skipReason: 'binary'
						};
					} else {
						const text = this.decoder.decode(bytes).replace(/\r\n?/g, '\n');
						totalIndexedBytes += bytes.byteLength;
						indexedFile = {
							...indexedFile,
							lines: text.split('\n')
						};
					}
				}
			} catch {
				indexedFile = {
					...indexedFile,
					skipReason: 'binary'
				};
			}

			indexedFiles.push(indexedFile);
		}

		this.files = indexedFiles;
		this.indexedFileCount = indexedFiles.length;
		this.searchableFileCount = indexedFiles.filter((file) => file.lines).length;
		this.skippedFileCount = indexedFiles.length - this.searchableFileCount;
	}

	private defaultResults(resultLimit: number): SearchResult[] {
		return this.files
			.slice()
			.sort((left, right) => {
				const leftParts = left.relativePath.split(/[\\/]/).length;
				const rightParts = right.relativePath.split(/[\\/]/).length;
				return leftParts - rightParts || left.relativePath.localeCompare(right.relativePath);
			})
			.slice(0, resultLimit)
			.map((file, index) => this.toFileResult(file, 20 - index * 0.1));
	}

	private searchWithQuery(query: NormalizedQuery, resultLimit: number): SearchResult[] {
		const results: SearchResult[] = [];
		const shouldSearchLines = query.compact.length >= 2;

		for (const file of this.files) {
			const pathScore = scorePathMatch(query, file);
			if (pathScore) {
				results.push(this.toFileResult(file, pathScore.score));
			}

			if (!shouldSearchLines || !file.lines) {
				continue;
			}

			const lineMatches: SearchResult[] = [];
			for (let index = 0; index < file.lines.length; index += 1) {
				const line = file.lines[index];
				const textScore = scoreTextMatch(query, line);
				if (!textScore) {
					continue;
				}

				lineMatches.push(
					this.toLineResult(
						file,
						index,
						textScore.firstMatchIndex + 1,
						line,
						textScore.score + (pathScore?.score ?? 0) * 0.15
					)
				);

				if (lineMatches.length >= MAX_LINE_MATCHES_PER_FILE) {
					break;
				}
			}

			results.push(...lineMatches);
		}

		return results
			.sort((left, right) => {
				return (
					right.score - left.score ||
					left.relativePath.localeCompare(right.relativePath) ||
					left.lineNumber - right.lineNumber
				);
			})
			.slice(0, resultLimit);
	}

	private toFileResult(file: IndexedFile, score: number): SearchResult {
		const preview = buildPreview(file.lines ?? ['Preview unavailable for this file.'], 0);
		return {
			id: `${file.relativePath}::file`,
			kind: 'file',
			score,
			uri: file.uri,
			relativePath: file.relativePath,
			title: file.relativePath,
			subtitle: file.skipReason ? previewSkipReason(file.skipReason) : 'Path match',
			lineNumber: 1,
			column: 1,
			preview
		};
	}

	private toLineResult(
		file: IndexedFile,
		lineIndex: number,
		column: number,
		lineText: string,
		score: number
	): SearchResult {
		return {
			id: `${file.relativePath}::${lineIndex + 1}:${column}`,
			kind: 'line',
			score,
			uri: file.uri,
			relativePath: file.relativePath,
			title: file.relativePath,
			subtitle: `${lineIndex + 1}:${column}  ${lineText.trim() || '(blank line)'}`,
			lineNumber: lineIndex + 1,
			column,
			preview: buildPreview(file.lines ?? [lineText], lineIndex)
		};
	}
}

function normalizeQuery(query: string): NormalizedQuery {
	const trimmed = query.trim().toLowerCase();
	const terms = trimmed.split(/\s+/).filter(Boolean);
	return {
		raw: query,
		trimmed,
		compact: trimmed.replace(/\s+/g, ''),
		terms
	};
}

function buildPreview(lines: string[], matchLineIndex: number): SearchResultPreview[] {
	const start = Math.max(0, matchLineIndex - PREVIEW_CONTEXT_RADIUS);
	const end = Math.min(lines.length - 1, matchLineIndex + PREVIEW_CONTEXT_RADIUS);
	const preview: SearchResultPreview[] = [];

	for (let index = start; index <= end; index += 1) {
		preview.push({
			lineNumber: index + 1,
			text: lines[index] ?? '',
			isMatch: index === matchLineIndex
		});
	}

	return preview;
}

function previewSkipReason(reason: NonNullable<IndexedFile['skipReason']>): string {
	switch (reason) {
		case 'tooLarge':
			return 'Path match only; preview skipped for large file';
		case 'budget':
			return 'Path match only; content indexing budget reached';
		case 'binary':
			return 'Path match only; binary or unreadable file';
		default:
			return 'Path match';
	}
}

function scorePathMatch(query: NormalizedQuery, file: IndexedFile): FuzzyScore | undefined {
	if (!query.compact) {
		return undefined;
	}

	const pathScore = fuzzySubsequenceScore(query.compact, file.pathKey);
	const baseNameScore = fuzzySubsequenceScore(query.compact, file.baseName);
	const bestScore = selectBestScore(pathScore, baseNameScore ? { ...baseNameScore, score: baseNameScore.score + 30 } : undefined);

	if (!bestScore) {
		return undefined;
	}

	let score = bestScore.score + 40;
	if (file.baseName.includes(query.trimmed)) {
		score += 30;
	}

	for (const term of query.terms) {
		if (file.pathKey.includes(term)) {
			score += 10;
		}
	}

	return {
		score,
		firstMatchIndex: bestScore.firstMatchIndex
	};
}

function scoreTextMatch(query: NormalizedQuery, line: string): FuzzyScore | undefined {
	if (!query.compact) {
		return undefined;
	}

	const lower = line.toLowerCase();
	let score = 0;
	let firstMatchIndex = Number.MAX_SAFE_INTEGER;

	for (const term of query.terms) {
		const exactIndex = lower.indexOf(term);
		if (exactIndex >= 0) {
			firstMatchIndex = Math.min(firstMatchIndex, exactIndex);
			score += 90 + Math.max(0, 15 - exactIndex);
			continue;
		}

		const fuzzy = fuzzySubsequenceScore(term, lower);
		if (!fuzzy) {
			return undefined;
		}

		firstMatchIndex = Math.min(firstMatchIndex, fuzzy.firstMatchIndex);
		score += fuzzy.score + 30;
	}

	if (query.terms.length === 0) {
		const fuzzy = fuzzySubsequenceScore(query.compact, lower);
		if (!fuzzy) {
			return undefined;
		}

		return {
			score: fuzzy.score,
			firstMatchIndex: fuzzy.firstMatchIndex
		};
	}

	if (lower.includes(query.trimmed)) {
		score += 50;
	}

	return {
		score: score - Math.min(40, line.length / 6),
		firstMatchIndex: firstMatchIndex === Number.MAX_SAFE_INTEGER ? 0 : firstMatchIndex
	};
}

function selectBestScore(left?: FuzzyScore, right?: FuzzyScore): FuzzyScore | undefined {
	if (!left) {
		return right;
	}

	if (!right) {
		return left;
	}

	return right.score > left.score ? right : left;
}

function fuzzySubsequenceScore(query: string, target: string): FuzzyScore | undefined {
	if (!query) {
		return {
			score: 0,
			firstMatchIndex: 0
		};
	}

	let queryIndex = 0;
	let score = 0;
	let previousTargetIndex = -1;
	let firstMatchIndex = -1;

	for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex += 1) {
		if (target[targetIndex] !== query[queryIndex]) {
			continue;
		}

		if (firstMatchIndex < 0) {
			firstMatchIndex = targetIndex;
		}

		score += 12;
		if (targetIndex === 0 || '/_- .'.includes(target[targetIndex - 1])) {
			score += 8;
		}
		if (previousTargetIndex >= 0) {
			const gap = targetIndex - previousTargetIndex - 1;
			score += gap === 0 ? 14 : Math.max(0, 8 - gap);
		}

		previousTargetIndex = targetIndex;
		queryIndex += 1;
	}

	if (queryIndex !== query.length || firstMatchIndex < 0) {
		return undefined;
	}

	score += Math.max(0, 25 - firstMatchIndex);
	score -= Math.max(0, target.length - query.length) * 0.15;

	return {
		score,
		firstMatchIndex
	};
}

function isProbablyBinary(bytes: Uint8Array): boolean {
	const sampleLength = Math.min(bytes.length, 512);
	let suspicious = 0;

	for (let index = 0; index < sampleLength; index += 1) {
		const value = bytes[index];
		if (value === 0) {
			return true;
		}
		if (value < 7 || (value > 14 && value < 32 && value !== 9 && value !== 10 && value !== 13)) {
			suspicious += 1;
		}
	}

	return suspicious / Math.max(1, sampleLength) > 0.3;
}
