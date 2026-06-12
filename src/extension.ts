import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';

const DEFAULT_FUNCTIONS_CONFIG_FILE = '.vscode/functions.yaml';
const DEFAULT_FORMATTERS_CONFIG_FILE = '.vscode/formatters.yaml';

interface ShellFunctionConfig {
  name?: unknown;
  description?: unknown;
  command?: unknown;
  cwd?: unknown;
  terminalName?: unknown;
  match?: unknown;
}

interface FormatterConfig {
  language?: unknown;
  languages?: unknown;
  command?: unknown;
  cwd?: unknown;
  match?: unknown;
}

interface FunctionsConfig {
  functions?: unknown;
}

interface FormattersConfig {
  formatters?: unknown;
}

interface MatchableConfig {
  match?: string;
  matchRegex?: RegExp;
}

interface ShellFunction {
  name: string;
  description: string;
  command: string;
  cwd?: string;
  terminalName?: string;
  match?: string;
  matchRegex?: RegExp;
}

interface Formatter extends MatchableConfig {
  languages: string[];
  command: string;
  cwd?: string;
}

type TemplateVariables = Record<string, string>;

interface CpuSnapshot {
  idle: number;
  total: number;
}

interface DiskUsage {
  used: number;
  total: number;
}

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    'yamlShellContextActions.run',
    async (resourceUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      try {
        await runShellFunction(resourceUri, selectedUris);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Shell function failed: ${message}`);
      }
    }
  );

  const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(
    { scheme: 'file' },
    new ConfiguredFormattingProvider()
  );

  context.subscriptions.push(disposable, formattingProvider);
  startSystemStatusBar(context);
}

async function runShellFunction(
  resourceUri?: vscode.Uri,
  selectedUris?: vscode.Uri[]
): Promise<void> {
  const targets = getTargets(resourceUri, selectedUris);
  if (targets.length === 0) {
    throw new Error('Right-click a file or folder in the Explorer.');
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(targets[0]);
  if (!workspaceFolder) {
    throw new Error('The selected item is not inside an open workspace.');
  }

  const configPath = getFunctionsConfigPath(workspaceFolder);
  let config: FunctionsConfig;
  try {
    config = await loadConfig<FunctionsConfig>(configPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  const allFunctions = normalizeFunctions(config.functions);

  if (allFunctions.length === 0) {
    return;
  }

  const functions = allFunctions.filter((fn) => appliesToTargets(fn, workspaceFolder, targets));
  if (functions.length === 0) {
    return;
  }

  const picked = await pickFunction(functions);
  if (!picked) {
    return;
  }

  const target = targets[0];
  const stats = await fs.promises.stat(target.fsPath);
  const variables = buildVariables(target, workspaceFolder, stats, targets);
  const command = interpolate(picked.command, variables);
  const cwd = interpolate(picked.cwd ?? '${rawWorkspaceFolder}', variables);

  if (!command.trim()) {
    throw new Error(`Function "${picked.name}" has an empty command.`);
  }

  const terminal = vscode.window.createTerminal({
    name: picked.terminalName ?? picked.name ?? 'Shell Function',
    cwd
  });

  terminal.show();
  terminal.sendText(command, true);
}

class ConfiguredFormattingProvider implements vscode.DocumentFormattingEditProvider {
  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return [];
    }

    let config: FormattersConfig;
    try {
      config = await loadConfig<FormattersConfig>(getFormattersConfigPath(workspaceFolder));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }

      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Formatter config failed: ${message}`);
      return [];
    }

    const formatter = normalizeFormatters(config.formatters)
      .find((candidate) => appliesToDocument(candidate, workspaceFolder, document));

    if (!formatter) {
      return [];
    }

    const stats = await fs.promises.stat(document.uri.fsPath);
    const variables = buildVariables(document.uri, workspaceFolder, stats, [document.uri]);
    const command = interpolate(formatter.command, variables);
    const cwd = interpolate(formatter.cwd ?? '${rawWorkspaceFolder}', variables);

    if (!command.trim()) {
      throw new Error(`Formatter for "${document.languageId}" has an empty command.`);
    }

    const original = document.getText();
    const formatted = await runFormatterCommand(command, cwd, original, token);
    if (token.isCancellationRequested || formatted === original) {
      return [];
    }

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(original.length)
    );

    return [vscode.TextEdit.replace(fullRange, formatted)];
  }
}

function getTargets(resourceUri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  const candidates = Array.isArray(selectedUris) && selectedUris.length > 0
    ? selectedUris
    : resourceUri
      ? [resourceUri]
      : [];

  return candidates.filter((uri) => uri.scheme === 'file');
}

function getFunctionsConfigPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return getConfiguredPath(
    workspaceFolder,
    'functionsConfigFile',
    DEFAULT_FUNCTIONS_CONFIG_FILE
  );
}

function getFormattersConfigPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return getConfiguredPath(
    workspaceFolder,
    'formattersConfigFile',
    DEFAULT_FORMATTERS_CONFIG_FILE
  );
}

function getConfiguredPath(
  workspaceFolder: vscode.WorkspaceFolder,
  settingName: string,
  defaultPath: string
): string {
  const configured = vscode.workspace
    .getConfiguration('yamlShellContextActions')
    .get<string>(settingName, defaultPath);

  return path.resolve(workspaceFolder.uri.fsPath, configured || defaultPath);
}

async function loadConfig<T extends object>(configPath: string): Promise<T> {
  let content: string;
  try {
    content = await fs.promises.readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      const missingConfigError = new Error(`Missing config file: ${configPath}`) as NodeJS.ErrnoException;
      missingConfigError.code = 'ENOENT';
      throw missingConfigError;
    }
    throw error;
  }

  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config file: ${configPath}`);
  }

  return parsed as T;
}

function normalizeFunctions(value: unknown): ShellFunction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is ShellFunctionConfig => Boolean(item) && typeof item === 'object')
    .map((item, index) => ({
      name: stringValue(item.name || `Function ${index + 1}`),
      description: stringValue(item.description || ''),
      command: stringValue(item.command || ''),
      cwd: item.cwd === undefined ? undefined : stringValue(item.cwd),
      terminalName: item.terminalName === undefined ? undefined : stringValue(item.terminalName),
      match: item.match === undefined ? undefined : stringValue(item.match)
    }))
    .map((item) => ({
      ...item,
      matchRegex: item.match ? compileMatchRegex(item.name, item.match) : undefined
    }))
    .filter((item) => item.command.trim().length > 0);
}

function normalizeFormatters(value: unknown): Formatter[] {
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

async function pickFunction(functions: ShellFunction[]): Promise<ShellFunction | undefined> {
  if (functions.length === 1) {
    return functions[0];
  }

  const picked = await vscode.window.showQuickPick(
    functions.map((fn) => ({
      label: fn.name,
      description: fn.description,
      detail: fn.command,
      fn
    })),
    {
      title: 'Run Shell Function',
      placeHolder: 'Choose the shell function to run'
    }
  );

  return picked?.fn;
}

function buildVariables(
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

function appliesToTargets(
  fn: MatchableConfig,
  workspaceFolder: vscode.WorkspaceFolder,
  targets: vscode.Uri[]
): boolean {
  if (!fn.matchRegex) {
    return true;
  }

  return targets.every((target) => fn.matchRegex?.test(getMatchPath(target, workspaceFolder)));
}

function appliesToDocument(
  formatter: Formatter,
  workspaceFolder: vscode.WorkspaceFolder,
  document: vscode.TextDocument
): boolean {
  return formatter.languages.includes(document.languageId)
    && appliesToTargets(formatter, workspaceFolder, [document.uri]);
}

function getMatchPath(target: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
  const relativePath = path.relative(workspaceFolder.uri.fsPath, target.fsPath);
  return normalizePathForMatch(relativePath || '.');
}

function normalizePathForMatch(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function compileMatchRegex(functionName: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid match regex for "${functionName}": ${message}`);
  }
}

function runFormatterCommand(
  command: string,
  cwd: string,
  input: string,
  token: vscode.CancellationToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true
    });

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

function startSystemStatusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'System Status';

  let previousCpu = getCpuSnapshot();
  let updating = false;

  const update = async (): Promise<void> => {
    if (updating) {
      return;
    }

    updating = true;
    try {
      const configuration = vscode.workspace.getConfiguration('yamlShellContextActions.systemStatus');
      const enabled = configuration.get<boolean>('enabled', true);

      if (!enabled) {
        item.hide();
        return;
      }

      const cpu = getCpuUsage(previousCpu);
      previousCpu = cpu.snapshot;

      const memory = getMemoryUsage();
      const disk = await getDiskUsage(getConfiguredDiskPath());
      const frequency = getCpuFrequency();

      item.text = [
        `CPU ${formatPercent(cpu.percent)} ${frequency}`,
        `RAM ${formatBytes(memory.used)}/${formatBytes(memory.total)}`,
        `Disk ${disk ? `${formatBytes(disk.used)}/${formatBytes(disk.total)}` : '--'}`
      ].join(' | ');

      item.tooltip = [
        'System status',
        `CPU usage: ${formatPercent(cpu.percent)}`,
        `CPU frequency: ${frequency}`,
        `RAM used: ${formatBytes(memory.used)} / ${formatBytes(memory.total)}`,
        disk
          ? `Storage used: ${formatBytes(disk.used)} / ${formatBytes(disk.total)}`
          : 'Storage used: unavailable'
      ].join('\n');

      item.show();
    } finally {
      updating = false;
    }
  };

  const intervalMs = Math.max(
    1000,
    vscode.workspace
      .getConfiguration('yamlShellContextActions.systemStatus')
      .get<number>('updateIntervalMs', 3000)
  );
  const interval = setInterval(update, intervalMs);

  update();
  context.subscriptions.push(item, { dispose: () => clearInterval(interval) });
}

function getCpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce(
    (snapshot, cpu) => {
      const times = cpu.times;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;

      return {
        idle: snapshot.idle + times.idle,
        total: snapshot.total + total
      };
    },
    { idle: 0, total: 0 }
  );
}

function getCpuUsage(previous: CpuSnapshot): { percent: number; snapshot: CpuSnapshot } {
  const snapshot = getCpuSnapshot();
  const idleDelta = snapshot.idle - previous.idle;
  const totalDelta = snapshot.total - previous.total;
  const percent = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

  return {
    percent: clamp(percent, 0, 100),
    snapshot
  };
}

function getCpuFrequency(): string {
  const cpus = os.cpus();
  if (cpus.length === 0) {
    return '--';
  }

  const averageMhz = cpus.reduce((sum, cpu) => sum + cpu.speed, 0) / cpus.length;
  if (!Number.isFinite(averageMhz) || averageMhz <= 0) {
    return '--';
  }

  return averageMhz >= 1000
    ? `${(averageMhz / 1000).toFixed(1)}GHz`
    : `${Math.round(averageMhz)}MHz`;
}

function getMemoryUsage(): { used: number; total: number } {
  const total = os.totalmem();
  return {
    used: total - os.freemem(),
    total
  };
}

function getConfiguredDiskPath(): string {
  const configured = vscode.workspace
    .getConfiguration('yamlShellContextActions.systemStatus')
    .get<string>('diskPath', '');

  if (configured.trim()) {
    return configured;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

function getDiskUsage(targetPath: string): Promise<DiskUsage | undefined> {
  return new Promise((resolve) => {
    execFile('df', ['-kP', targetPath], (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }

      const lines = stdout.trim().split(/\r?\n/);
      if (lines.length < 2) {
        resolve(undefined);
        return;
      }

      const columns = lines[1].trim().split(/\s+/);
      const totalBlocks = Number(columns[1]);
      const usedBlocks = Number(columns[2]);

      if (!Number.isFinite(totalBlocks) || !Number.isFinite(usedBlocks)) {
        resolve(undefined);
        return;
      }

      resolve({
        used: usedBlocks * 1024,
        total: totalBlocks * 1024
      });
    });
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 10) {
    return `${Math.round(gib)}GB`;
  }

  return `${gib.toFixed(1)}GB`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function interpolate(template: string, variables: TemplateVariables): string {
  return String(template).replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

export function quoteShell(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function deactivate(): void {}
