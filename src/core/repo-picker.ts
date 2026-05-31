/**
 * Advanced Repository Picker
 * Deduplicates local and GitHub repositories with intelligent matching
 */

import { resolve } from 'path';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import type { AppConfig } from '../models/types.js';

export interface RepoItem {
  id: string;
  type: 'local' | 'github';
  label: string;
  path: string;
  nameWithOwner: string | null;
  description: string;
  isCloned: boolean;
}

export interface RepoPickerOptions {
  workspaceRoot: string;
  repos: Array<{ name: string; path: string; description?: string }>;
  ghLimit?: number;
}

export interface RepoPickerResult {
  items: RepoItem[];
  error: string | null;
}

export class RepoPicker {
  constructor(private options: RepoPickerOptions) {}

  async buildItems(): Promise<RepoPickerResult> {
    const items: RepoItem[] = [];
    let error: string | null = null;

    // Track seen paths and names for deduplication
    const seenPaths = new Set<string>();
    const seenNames = new Set<string>();
    const localByName = new Map<string, string>();

    await this.addLocalItems(items, seenPaths, seenNames, localByName);

    // 3. Fetch GitHub repos
    const ghRepos = await this.fetchGitHubRepos();

    if (ghRepos.error) {
      error = ghRepos.error;
    }

    const labelCounts = new Map<string, number>();
    let ghIndex = 0;

    for (const gh of ghRepos.repos) {
      const nwo = gh.nameWithOwner;
      const repoName = this.extractRepoName(nwo);

      // Check if already cloned locally
      if (localByName.has(repoName)) {
        continue;
      }

      // Check if clone target would collide with existing path
      const targetPath = resolve(this.options.workspaceRoot, repoName);
      if (existsSync(targetPath)) {
        continue;
      }

      // Generate unique label
      const baseLabel = `github-${repoName}`;
      const count = labelCounts.get(baseLabel) || 0;
      labelCounts.set(baseLabel, count + 1);

      const label = count === 0 ? baseLabel : `github-${nwo.replace('/', '-')}`;

      items.push({
        id: `github-${ghIndex}`,
        type: 'github',
        label,
        path: targetPath,
        nameWithOwner: nwo,
        description: gh.description || '',
        isCloned: false,
      });
      ghIndex++;
    }

    return { items, error };
  }

  /** Local configured repos + workspace folders (same sources as the web repo picker). */
  async buildLocalItems(): Promise<RepoItem[]> {
    const items: RepoItem[] = [];
    const seenPaths = new Set<string>();
    const seenNames = new Set<string>();
    const localByName = new Map<string, string>();

    await this.addLocalItems(items, seenPaths, seenNames, localByName);
    return items;
  }

  private async addLocalItems(
    items: RepoItem[],
    seenPaths: Set<string>,
    seenNames: Set<string>,
    localByName: Map<string, string>
  ): Promise<void> {
    // 1. Add configured repos first
    for (const repo of this.options.repos) {
      if (!existsSync(repo.path)) continue;

      const resolvedPath = resolve(repo.path);
      if (seenPaths.has(resolvedPath)) continue;

      seenPaths.add(resolvedPath);
      seenNames.add(repo.name);
      localByName.set(repo.name, resolvedPath);

      items.push({
        id: `local-${repo.name}`,
        type: 'local',
        label: `local-${repo.name}`,
        path: resolvedPath,
        nameWithOwner: null,
        description: repo.description || '',
        isCloned: true,
      });
    }

    // 2. Scan workspace directories
    const workspaceEntries = await this.scanWorkspace();
    let localIndex = 0;

    for (const entry of workspaceEntries) {
      if (seenPaths.has(entry.path)) continue;
      if (seenNames.has(entry.name)) {
        let counter = 1;
        let newName = `${entry.name}-${counter}`;
        while (seenNames.has(newName)) {
          counter++;
          newName = `${entry.name}-${counter}`;
        }
        entry.name = newName;
      }

      seenPaths.add(entry.path);
      seenNames.add(entry.name);
      localByName.set(entry.name, entry.path);

      items.push({
        id: `local-ws-${localIndex}`,
        type: 'local',
        label: `local-${entry.name}`,
        path: entry.path,
        nameWithOwner: null,
        description: '',
        isCloned: true,
      });
      localIndex++;
    }
  }

  private async scanWorkspace(): Promise<Array<{ name: string; path: string }>> {
    const entries: Array<{ name: string; path: string }> = [];

    try {
      const dirEntries = await readdir(this.options.workspaceRoot, { withFileTypes: true });

      for (const entry of dirEntries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const path = resolve(this.options.workspaceRoot, entry.name);

        entries.push({
          name: entry.name,
          path,
        });
      }
    } catch {
      // Directory might not exist
    }

    return entries;
  }

  private async fetchGitHubRepos(): Promise<{
    repos: Array<{ nameWithOwner: string; description?: string }>;
    error: string | null;
  }> {
    const repos: Array<{ nameWithOwner: string; description?: string }> = [];

    try {
      const { execa } = await import('execa');
      const { stdout } = await execa(
        'gh',
        ['repo', 'list', '--limit', String(this.options.ghLimit || 80), '--json', 'nameWithOwner,description'],
        { timeout: 30000 }
      );

      const parsed = JSON.parse(stdout) as Array<{
        nameWithOwner: string;
        description?: string;
      }>;

      for (const repo of parsed) {
        if (repo.nameWithOwner) {
          repos.push(repo);
        }
      }

      return { repos, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        repos: [],
        error: `GitHub CLI not available or not authenticated: ${message}`,
      };
    }
  }

  private extractRepoName(nameWithOwner: string): string {
    const parts = nameWithOwner.split('/');
    return parts[parts.length - 1] || nameWithOwner;
  }
}

export async function buildRepoPicker(
  config: AppConfig,
  ghLimit = 80
): Promise<RepoPickerResult> {
  const picker = new RepoPicker({
    workspaceRoot: config.workspaceRoot,
    repos: config.repos,
    ghLimit,
  });

  return picker.buildItems();
}

/** List local workspace folders — shared by web repo picker and Telegram /workspaces. */
export async function listLocalWorkspaceItems(config: AppConfig): Promise<RepoItem[]> {
  const picker = new RepoPicker({
    workspaceRoot: config.workspaceRoot,
    repos: config.repos,
  });

  return picker.buildLocalItems();
}
