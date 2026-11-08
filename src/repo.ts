import type { HostClient } from '@openchamber/sdk';
import type { Repo } from './api.ts';

// Finds the Bitbucket repositories of the open project by reading git's own
// files with the `files` capability: the project itself and its submodules
// (`.git/modules/<name>`). Paths stay inside the project, so a linked
// worktree, whose `.git` file points outside it, is not read.

export type LocalRepo = {
  repo: Repo;
  /** Where it sits in the project: '' for the project itself, else the submodule path. */
  path: string;
  /** Checked-out branch, null on a detached HEAD or when it could not be read. */
  branch: string | null;
};

export type Detection = { repos: LocalRepo[]; note: string | null };

/** `git@bitbucket.org:ws/repo.git`, `git@ssh.bitbucket.org:ws/repo`, `https://user@bitbucket.org/ws/repo.git`, `ssh://git@bitbucket.org/ws/repo.git`. */
export const parseBitbucketUrl = (url: string): Repo | null => {
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:ssh\.)?bitbucket\.org(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match?.[1] && match[2] ? { workspace: match[1].toLowerCase(), slug: match[2].toLowerCase() } : null;
};

/** The url of `[remote "origin"]`, or of the first remote when there is no origin. */
export const originUrl = (config: string): string | null => {
  let section = '';
  const remotes = new Map<string, string>();
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      section = header[1];
      continue;
    }
    const remote = /^remote\s+"(.+)"$/.exec(section);
    const value = /^url\s*=\s*(.+)$/.exec(line);
    if (remote?.[1] && value?.[1] && !remotes.has(remote[1])) remotes.set(remote[1], value[1]);
  }
  return remotes.get('origin') ?? remotes.values().next().value ?? null;
};

export const branchOf = (head: string): string | null => /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim())?.[1] ?? null;

/** Submodule name → path from `.gitmodules`. */
const submodulePaths = (gitmodules: string) => {
  const paths = new Map<string, string>();
  let name: string | null = null;
  for (const raw of gitmodules.split('\n')) {
    const line = raw.trim();
    const header = /^\[submodule\s+"(.+)"\]$/.exec(line);
    if (header?.[1]) {
      name = header[1];
      continue;
    }
    const value = /^path\s*=\s*(.+)$/.exec(line);
    if (name && value?.[1]) paths.set(name, value[1]);
  }
  return paths;
};

export const detectRepos = async (host: HostClient): Promise<Detection> => {
  const read = (path: string) => host.readFile(path).then((file) => file.content, () => null);

  const dotGit = await host.stat('.git').catch(() => null);
  if (!dotGit || dotGit.kind === 'missing') return { repos: [], note: 'В этой папке нет git-репозитория.' };
  if (dotGit.kind !== 'directory') {
    return { repos: [], note: 'Это linked worktree: его git-данные лежат вне проекта, и секция их не читает. Откройте панель Bitbucket и выберите репозиторий там.' };
  }

  const repos: LocalRepo[] = [];
  const rootConfig = await read('.git/config');
  const rootUrl = rootConfig ? originUrl(rootConfig) : null;
  const rootRepo = rootUrl ? parseBitbucketUrl(rootUrl) : null;
  if (rootRepo) {
    const head = await read('.git/HEAD');
    repos.push({ repo: rootRepo, path: '', branch: head ? branchOf(head) : null });
  }

  const modules = await host.listDir('.git/modules').then((list) => list.entries, () => []);
  if (modules.length > 0) {
    const gitmodules = await read('.gitmodules');
    const paths = gitmodules ? submodulePaths(gitmodules) : new Map<string, string>();
    const found = await Promise.all(
      modules
        .filter((entry) => entry.kind === 'directory')
        .map(async (entry): Promise<LocalRepo | null> => {
          const config = await read(`.git/modules/${entry.name}/config`);
          const url = config ? originUrl(config) : null;
          const repo = url ? parseBitbucketUrl(url) : null;
          if (!repo) return null;
          const head = await read(`.git/modules/${entry.name}/HEAD`);
          return { repo, path: paths.get(entry.name) ?? entry.name, branch: head ? branchOf(head) : null };
        }),
    );
    for (const repo of found) if (repo) repos.push(repo);
  }

  if (repos.length === 0) return { repos, note: 'У репозитория нет remote на bitbucket.org.' };
  return { repos, note: null };
};

const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

/** Long-lived branches that pull requests go into, not out of. */
export const isDefaultBranch = (branch: string) => DEFAULT_BRANCHES.has(branch);

/** The repository to show first: one with work on a feature branch, else the project itself. */
export const preferredRepo = (repos: LocalRepo[]): LocalRepo | null =>
  repos.find((local) => local.branch && !DEFAULT_BRANCHES.has(local.branch)) ?? repos[0] ?? null;

/** Storage key for the repository the user picked in a project; keys are capped at 128 characters. */
export const pickKey = (directory: string) => {
  let hash = 5381;
  for (let index = 0; index < directory.length; index += 1) hash = ((hash << 5) + hash + directory.charCodeAt(index)) | 0;
  return `repo:${(hash >>> 0).toString(36)}:${directory.slice(-80)}`;
};

/** Id of a project repository, shared by the section and the panel: its path in the project. */
export const localId = (local: LocalRepo) => (local.path || '.').slice(0, 80);

export const localLabel = (local: LocalRepo) =>
  `${local.path || local.repo.slug}${local.branch ? ` · ${local.branch}` : ''}`;
