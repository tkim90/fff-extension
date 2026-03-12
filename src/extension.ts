import * as vscode from 'vscode';
import { ModalFindPanel } from './ModalFindPanel';

export function activate(context: vscode.ExtensionContext): void {
	const openCommand = vscode.commands.registerCommand('modal-find.open', () => {
		ModalFindPanel.createOrShow(context.extensionUri);
	});

	context.subscriptions.push(openCommand);
}

export function deactivate(): void {}
