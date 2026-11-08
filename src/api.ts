import { HostRequestError, type HostClient } from '@openchamber/sdk';

// Every call goes through host.request: the host adds `Basic email:token` and
// keeps the request on https://api.bitbucket.org. The host does not follow
// redirects, so endpoints that answer 302 (/pullrequests/{id}/diff) are
// replaced by the address they would redirect to.

export type Repo = { workspace: string; slug: string };
export const repoKey = (repo: Repo) => `${repo.workspace}/${repo.slug}`;

export type User = { uuid: string; display_name: string; nickname?: string };

export type Participant = {
  user: User;
  role: 'PARTICIPANT' | 'REVIEWER';
  approved: boolean;
  state: 'approved' | 'changes_requested' | null;
};

export type PullRequest = {
  id: number;
  title: string;
  description: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft: boolean;
  author: User;
  source: { branch: { name: string }; commit?: { hash: string } };
  destination: { branch: { name: string }; commit?: { hash: string } };
  reviewers: User[];
  participants: Participant[];
  comment_count: number;
  task_count: number;
  close_source_branch: boolean;
  created_on: string;
  updated_on: string;
  links: { html: { href: string } };
};

export type Comment = {
  id: number;
  content: { raw: string };
  user: User;
  created_on: string;
  deleted: boolean;
  inline?: unknown;
  parent?: { id: number };
};

export type CommitStatus = {
  key: string;
  name: string;
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED';
  url: string;
};

export type MergeStrategy =
  | 'merge_commit'
  | 'squash'
  | 'fast_forward'
  | 'squash_fast_forward'
  | 'rebase_fast_forward'
  | 'rebase_merge';

export const MERGE_STRATEGY_LABELS: Record<MergeStrategy, string> = {
  merge_commit: 'Merge commit',
  squash: 'Squash',
  fast_forward: 'Fast forward',
  squash_fast_forward: 'Squash, fast forward',
  rebase_fast_forward: 'Rebase, fast forward',
  rebase_merge: 'Rebase, merge',
};

export class BitbucketError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

type Page<T> = { values: T[]; next?: string; size?: number };

const readError = (status: number, body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; detail?: string } };
    const message = parsed.error?.message;
    if (message) return parsed.error?.detail ? `${message}: ${parsed.error.detail}` : message;
  } catch {
    // not JSON
  }
  return `Bitbucket answered ${status}`;
};

/** A user-facing sentence for any failure of a Bitbucket call. */
export const describeError = (error: unknown, options: { write?: boolean } = {}): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'HOST_TIMEOUT' && options.write) {
      return 'Bitbucket не ответил за 20 секунд, но изменение могло примениться. Нажмите «Обновить» и проверьте PR, прежде чем повторять.';
    }
    if (error.code === 'DISCONNECTED') return 'Bitbucket не подключён: Settings → Integrations → Bitbucket, email и API-токен.';
    if (error.code === 'NOT_GRANTED') return 'Расширению не выдано разрешение. Откройте Settings → Extensions → Bitbucket и подтвердите доступ.';
    if (error.code === 'HOST_TIMEOUT') return 'Bitbucket не ответил за 20 секунд. Попробуйте ещё раз.';
    return error.message;
  }
  if (error instanceof BitbucketError) {
    if (error.status === 403) return `Токену не хватает прав (403): ${error.message}. Выпустите токен со скоупами Bitbucket для репозиториев и pull requests.`;
    if (error.status === 404) return 'Bitbucket не нашёл репозиторий или PR (404). Проверьте, что у аккаунта есть к нему доступ.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

/** A toast that always shows: the host refuses messages over 500 characters. */
export const say = (host: HostClient, kind: 'info' | 'success' | 'error', message: string) => {
  const text = message.trim();
  return host.toast({ kind, message: text.length > 500 ? `${text.slice(0, 497)}…` : text }).catch(() => {});
};

export const createApi = (host: HostClient) => {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: { query?: Record<string, string>; body?: unknown } = {}) => {
    const result = await host.request({
      method,
      path: `/2.0${path}`,
      query: options.query,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (result.status < 200 || result.status >= 300) {
      throw new BitbucketError(readError(result.status, result.body), result.status);
    }
    return result;
  };
  const json = async <T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> => {
    const result = await call(method, path, options);
    return (result.body ? JSON.parse(result.body) : null) as T;
  };
  const repoPath = (repo: Repo) => `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.slug)}`;
  const prPath = (repo: Repo, id: number) => `${repoPath(repo)}/pullrequests/${id}`;
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  let me: Promise<User> | null = null;
  const getMe = () => {
    me ??= json<User>('GET', '/user').catch((error) => {
      me = null;
      throw error;
    });
    return me;
  };

  return {
    me: getMe,

    repository: (repo: Repo) => json<{ full_name: string; mainbranch?: { name: string } }>('GET', repoPath(repo), {
      query: { fields: 'full_name,mainbranch.name' },
    }),

    mergeStrategies: async (repo: Repo, branch: string) => {
      const answer = await json<{ merge_strategies?: MergeStrategy[]; default_merge_strategy?: MergeStrategy }>(
        'GET',
        `${repoPath(repo)}/refs/branches/${encodeURIComponent(branch)}`,
        { query: { fields: 'merge_strategies,default_merge_strategy' } },
      );
      return { strategies: answer.merge_strategies ?? ['merge_commit'], fallback: answer.default_merge_strategy ?? 'merge_commit' };
    },

    /** Open PRs. `filter`: all, authored by me, or where I am a reviewer. */
    listPullRequests: async (repo: Repo, filter: 'open' | 'mine' | 'review', search = '') => {
      const clauses = ['state = "OPEN"'];
      if (filter !== 'open') {
        const user = await getMe();
        clauses.push(filter === 'mine' ? `author.uuid = ${quote(user.uuid)}` : `reviewers.uuid = ${quote(user.uuid)}`);
      }
      if (search) clauses.push(`title ~ ${quote(search)}`);
      const page = await json<Page<PullRequest>>('GET', `${repoPath(repo)}/pullrequests`, {
        // The list answers short PR objects without participants and reviewers; ask for them.
        query: { q: clauses.join(' AND '), pagelen: '50', sort: '-updated_on', fields: '+values.participants,+values.reviewers' },
      });
      return page.values.map((pr) => ({ ...pr, participants: pr.participants ?? [], reviewers: pr.reviewers ?? [] }));
    },

    /** The open PR whose source is `branch`, or null. */
    pullRequestForBranch: async (repo: Repo, branch: string) => {
      const page = await json<Page<{ id: number }>>('GET', `${repoPath(repo)}/pullrequests`, {
        query: { q: `source.branch.name = ${quote(branch)} AND state = "OPEN"`, pagelen: '1', fields: 'values.id' },
      });
      const found = page.values[0];
      return found ? json<PullRequest>('GET', prPath(repo, found.id)) : null;
    },

    pullRequest: (repo: Repo, id: number) => json<PullRequest>('GET', prPath(repo, id)),

    statuses: async (repo: Repo, id: number) => {
      const page = await json<Page<CommitStatus>>('GET', `${prPath(repo, id)}/statuses`, {
        query: { pagelen: '20', fields: 'values.key,values.name,values.state,values.url' },
      });
      return page.values;
    },

    comments: async (repo: Repo, id: number) => {
      const page = await json<Page<Comment>>('GET', `${prPath(repo, id)}/comments`, {
        query: { pagelen: '100', sort: 'created_on' },
      });
      return page.values.filter((comment) => !comment.deleted && !comment.inline);
    },

    /** Unified diff of the PR, the same text /pullrequests/{id}/diff redirects to. */
    diff: async (repo: Repo, pr: PullRequest) => {
      const source = pr.source.commit?.hash;
      const destination = pr.destination.commit?.hash;
      if (!source || !destination) throw new BitbucketError('У PR нет коммитов для диффа.', 0);
      const spec = `${repoKey(repo)}:${source}%0D${destination}`;
      const result = await call('GET', `${repoPath(repo)}/diff/${spec}`, {
        query: { from_pullrequest_id: String(pr.id), topic: 'true' },
      });
      return result.body;
    },

    members: async (repo: Repo) => {
      const page = await json<Page<{ user: User }>>('GET', `/workspaces/${encodeURIComponent(repo.workspace)}/members`, {
        query: { pagelen: '100', fields: 'values.user.uuid,values.user.display_name,values.user.nickname' },
      });
      return page.values.map((member) => member.user);
    },

    defaultReviewers: async (repo: Repo) => {
      const page = await json<Page<{ user: User }>>('GET', `${repoPath(repo)}/effective-default-reviewers`, {
        query: { pagelen: '100', fields: 'values.user.uuid,values.user.display_name' },
      });
      return page.values.map((entry) => entry.user);
    },

    createPullRequest: (repo: Repo, input: { title: string; description: string; source: string; destination: string; reviewers: string[]; draft: boolean; closeSourceBranch: boolean }) =>
      json<PullRequest>('POST', `${repoPath(repo)}/pullrequests`, {
        body: {
          title: input.title,
          description: input.description,
          source: { branch: { name: input.source } },
          destination: { branch: { name: input.destination } },
          reviewers: input.reviewers.map((uuid) => ({ uuid })),
          draft: input.draft,
          close_source_branch: input.closeSourceBranch,
        },
      }),

    /**
     * A PUT that leaves out `reviewers` (or `title`, `description`) can clear
     * them, so the current values always travel along with the change.
     */
    updatePullRequest: (repo: Repo, pr: PullRequest, changes: { title?: string; description?: string; draft?: boolean; reviewers?: string[] }) =>
      json<PullRequest>('PUT', prPath(repo, pr.id), {
        body: {
          title: changes.title ?? pr.title,
          description: changes.description ?? pr.description,
          reviewers: (changes.reviewers ?? pr.reviewers.map((user) => user.uuid)).map((uuid) => ({ uuid })),
          ...(changes.draft === undefined ? {} : { draft: changes.draft }),
        },
      }),

    approve: (repo: Repo, id: number, on: boolean) => call(on ? 'POST' : 'DELETE', `${prPath(repo, id)}/approve`),
    requestChanges: (repo: Repo, id: number, on: boolean) => call(on ? 'POST' : 'DELETE', `${prPath(repo, id)}/request-changes`),
    decline: (repo: Repo, id: number) => call('POST', `${prPath(repo, id)}/decline`),

    /**
     * `async=true` makes Bitbucket answer at once: 200 when merged, 202 when it
     * runs the merge as a task (or adds the PR to a merge queue). A synchronous
     * merge could outlast the host's 20-second request limit.
     */
    merge: async (repo: Repo, id: number, strategy: MergeStrategy, closeSourceBranch: boolean) => {
      const result = await call('POST', `${prPath(repo, id)}/merge`, {
        query: { async: 'true' },
        body: { type: 'pullrequest', merge_strategy: strategy, close_source_branch: closeSourceBranch },
      });
      return { queued: result.status === 202 };
    },

    comment: (repo: Repo, id: number, text: string) =>
      json<Comment>('POST', `${prPath(repo, id)}/comments`, { body: { content: { raw: text } } }),
  };
};

export type Api = ReturnType<typeof createApi>;

/** The state of the current user's review on a PR. */
export const myReview = (pr: PullRequest, uuid: string) => {
  const mine = pr.participants.find((participant) => participant.user.uuid === uuid);
  return { approved: Boolean(mine?.approved), changesRequested: mine?.state === 'changes_requested' };
};

export const reviewSummary = (pr: PullRequest) => ({
  approvals: pr.participants.filter((participant) => participant.approved).map((participant) => participant.user.display_name),
  changes: pr.participants.filter((participant) => participant.state === 'changes_requested').map((participant) => participant.user.display_name),
});

/** One badge for the PR's commit statuses (Pipelines and other CI). */
export const pipelineSummary = (statuses: CommitStatus[]) => {
  if (statuses.length === 0) return null;
  if (statuses.some((status) => status.state === 'FAILED')) return { label: 'Pipeline: failed', tone: 'error' as const, url: statuses.find((status) => status.state === 'FAILED')?.url };
  if (statuses.some((status) => status.state === 'INPROGRESS')) return { label: 'Pipeline: running', tone: 'info' as const, url: statuses.find((status) => status.state === 'INPROGRESS')?.url };
  if (statuses.some((status) => status.state === 'STOPPED')) return { label: 'Pipeline: stopped', tone: 'warning' as const, url: statuses[0]?.url };
  return { label: 'Pipeline: passed', tone: 'success' as const, url: statuses[0]?.url };
};

/** The composer chip that hands a PR to the agent: description plus as much diff as fits. */
export const pullRequestChip = (repo: Repo, pr: PullRequest, diff: string) => {
  const LIMIT = 15_500;
  const header = [
    `Bitbucket pull request ${repoKey(repo)}#${pr.id}: ${pr.title}`,
    `URL: ${pr.links.html.href}`,
    `Branches: ${pr.source.branch.name} → ${pr.destination.branch.name}`,
    `Author: ${pr.author.display_name}. State: ${pr.draft ? 'DRAFT' : pr.state}.`,
    '',
    pr.description || '(no description)',
    '',
    'Diff:',
  ].join('\n');
  const room = LIMIT - header.length - 120;
  const cut = diff.length > room;
  const body = cut
    ? `${diff.slice(0, Math.max(0, room))}\n\n[Diff cut here: ${diff.length} characters in total. Read the rest with git or from the URL above.]`
    : diff;
  return {
    providerId: 'bitbucket',
    id: `${repoKey(repo)}#${pr.id}`.slice(0, 128),
    title: `${pr.title} (#${pr.id})`.slice(0, 200),
    url: pr.links.html.href,
    kind: 'pull' as const,
    author: pr.author.display_name.slice(0, 80),
    branches: { head: pr.source.branch.name, base: pr.destination.branch.name },
    text: `${header}\n${body}`,
    data: { workspace: repo.workspace, slug: repo.slug, id: pr.id },
  };
};
