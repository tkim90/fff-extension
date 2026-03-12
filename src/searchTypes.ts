import * as vscode from 'vscode';

export interface SearchResultPreview {
	lineNumber: number;
	text: string;
	isMatch: boolean;
}

export interface SearchResult {
	id: string;
	kind: 'file' | 'line';
	score: number;
	uri: vscode.Uri;
	relativePath: string;
	title: string;
	subtitle: string;
	lineNumber: number;
	column: number;
	preview: SearchResultPreview[];
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
	indexedFileCount: number;
	searchableFileCount: number;
	skippedFileCount: number;
	durationMs: number;
}
