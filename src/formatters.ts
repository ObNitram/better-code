import { spawn } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Formatter } from './types';
import { appliesToTargets, buildVariables, compileMatchRegex, getMatchPath, interpolate, stringValue } from './utils';

interface FormatterConfig {
  language?: unknown;
  languages?: unknown;
  command?: unknown;
  cwd?: unknown;
  match?: unknown;
}

export function normalizeFormatters(value: unknown): Formatter[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is FormatterConfig => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const languages = normalizeLanguages(item.language, item.languages);
      const command = stringValue(item.command || '');
      const match = item.match === undefined ? undefined : stringValue(item.match);

      return {
        languages,
        command,
        cwd: item.cwd === undefined ? undefined : stringValue(item.cwd),
        match,
        matchRegex: match ? compileMatchRegex(`formatter for ${languages.join(', ')}`, match) : undefined
      };
    })
    .filter((item) => item.languages.length > 0 && item.command.trim().length > 0);
}

function normalizeLanguages(language: unknown, languages: unknown): string[] {
  const values = [
    ...(typeof language === 'string' ? [language] : []),
    ...(Array.isArray(languages) ? languages.filter((item): item is string => typeof item === 'string') : [])
  ];

  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function appliesToDocument(
  formatter: Formatter,
  workspaceFolder: vscode.WorkspaceFolder,
  document: vscode.TextDocument
): boolean {
  return formatter.languages.includes(document.languageId)
    && appliesToTargets(formatter, workspaceFolder, [document.uri]);
}

export class ConfiguredFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly output: vscode.OutputChannel) {}

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return [];
    }

    const formatter = normalizeFormatters(
      vscode.workspace.getConfiguration('obnicode', workspaceFolder.uri).get('formatters')
    ).find((candidate) => appliesToDocument(candidate, workspaceFolder, document));

    if (!formatter) {
      return [];
    }

    const stats = await fs.promises.stat(document.uri.fsPath);
    const variables = buildVariables(document.uri, workspaceFolder, stats, [document.uri]);
    const command = interpolate(formatter.command, variables);
    const cwd = interpolate(formatter.cwd ?? '${rawWorkspaceFolder}', variables);
    const startedAt = Date.now();
    this.logEvent('START', document, workspaceFolder, `command=${command}`);

    if (!command.trim()) {
      const message = `Formatter for "${document.languageId}" has an empty command.`;
      this.logEvent('ERROR', document, workspaceFolder, message);
      return [];
    }

    const original = document.getText();
    let formatted: string;
    try {
      formatted = await runCommand(command, cwd, original, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent('ERROR', document, workspaceFolder, message, startedAt);
      return [];
    }

    if (token.isCancellationRequested || formatted === original) {
      this.logEvent('SUCCESS', document, workspaceFolder, 'no changes', startedAt);
      return [];
    }

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(original.length)
    );

    this.logEvent('SUCCESS', document, workspaceFolder, 'document changed', startedAt);
    return [vscode.TextEdit.replace(fullRange, formatted)];
  }

  private logEvent(
    status: 'START' | 'SUCCESS' | 'ERROR',
    document: vscode.TextDocument,
    workspaceFolder: vscode.WorkspaceFolder,
    message: string,
    startedAt?: number
  ): void {
    const elapsed = startedAt === undefined ? '' : ` duration=${Date.now() - startedAt}ms`;
    const relativePath = getMatchPath(document.uri, workspaceFolder);
    this.output.appendLine(
      `[${new Date().toISOString()}] ${status} ${relativePath} language=${document.languageId}${elapsed} ${message}`
    );
  }
}

function runCommand(
  command: string,
  cwd: string,
  input: string,
  token: vscode.CancellationToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error, output?: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cancellation.dispose();

      if (error) {
        reject(error);
      } else {
        resolve(output ?? '');
      }
    };

    const cancellation = token.onCancellationRequested(() => {
      child.kill();
      finish(new Error('Formatting cancelled.'));
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(undefined, stdout);
        return;
      }

      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const details = stderr.trim() ? `: ${stderr.trim()}` : '';
      finish(new Error(`Formatter command failed with ${status}${details}`));
    });

    child.stdin.end(input, 'utf8');
  });
}
