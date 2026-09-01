export interface MatchableConfig {
  match?: string;
  matchRegex?: RegExp;
}

export interface ExplorerViewAction extends MatchableConfig {
  name: string;
  description: string;
  command: string;
  cwd?: string;
  terminalName?: string;
  useTerminal: boolean;
}

export interface Formatter extends MatchableConfig {
  languages: string[];
  command: string;
  cwd?: string;
}

export type TemplateVariables = Record<string, string>;
