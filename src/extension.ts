import * as vscode from 'vscode';
import { disposeDebugResources, getDebugOptions, traceLifecycle } from './debug';
import { ModalFindPanel } from './ModalFindPanel';
import { SearchSettingsCache } from './searchSettingsCache';
import { SearchService } from './searchService';

export function activate(context: vscode.ExtensionContext): void {
	traceLifecycle('extension.activate.start');

	const searchService = new SearchService(context.extensionUri);
	const settingsCache = new SearchSettingsCache(context.workspaceState);
	ModalFindPanel.warmupAssets(context.extensionUri);
	if (getDebugOptions().disableWarmup) {
		traceLifecycle('search.warmup.skipped', {
			source: 'activate',
			reason: 'config.disableWarmup'
		});
	} else {
		void searchService.warmup('activate');
	}

	const openCommand = vscode.commands.registerCommand('fast-fuzzy-finder.open', () => {
		const editor = vscode.window.activeTextEditor;
		const selectedText = editor && !editor.selection.isEmpty
			? editor.document.getText(editor.selection)
			: undefined;
		traceLifecycle('command.invoked', {
			command: 'fast-fuzzy-finder.open',
			hasSelection: Boolean(selectedText)
		});
		ModalFindPanel.createOrShow(context, searchService, settingsCache, selectedText);
	});

	context.subscriptions.push(searchService, openCommand, { dispose: disposeDebugResources });
	traceLifecycle('extension.activate.end');
}

export function deactivate(): void {
	ModalFindPanel.disposeCurrentPanel();
	disposeDebugResources();
}
