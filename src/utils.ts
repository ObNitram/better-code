import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MatchableConfig, TemplateVariables } from './types';

export function interpolate(template: string, variables: TemplateVariables): string {
  return String(template).replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

export function quoteShell(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

export function compileMatchRegex(label: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid match regex for "${label}": ${message}`);
  }
}

export function buildVariables(
  target: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder,
  stats: fs.Stats,
  allTargets: vscode.Uri[]
): TemplateVariables {
  const filePath = target.fsPath;
  const workspacePath = workspaceFolder.uri.fsPath;
  const relativePath = path.relative(workspacePath, filePath);
  const selectedPaths = allTargets.map((uri) => quoteShell(uri.fsPath)).join(' ');

  return {
    path: quoteShell(filePath),
    rawPath: filePath,
    relativePath: quoteShell(relativePath),
    rawRelativePath: relativePath,
    workspaceFolder: quoteShell(workspacePath),
    rawWorkspaceFolder: workspacePath,
    fileBasename: quoteShell(path.basename(filePath)),
    rawFileBasename: path.basename(filePath),
    fileDirname: quoteShell(path.dirname(filePath)),
    rawFileDirname: path.dirname(filePath),
    selectedPaths,
    selectedType: stats.isDirectory() ? 'folder' : 'file'
  };
}

export function getMatchPath(target: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
  const relativePath = path.relative(workspaceFolder.uri.fsPath, target.fsPath);
  return relativePath.split(path.sep).join('/') || '.';
}

export function appliesToTargets(
  action: MatchableConfig,
  workspaceFolder: vscode.WorkspaceFolder,
  targets: vscode.Uri[]
): boolean {
  if (!action.matchRegex) {
    return true;
  }

  return targets.every((target) => action.matchRegex?.test(getMatchPath(target, workspaceFolder)));
}
