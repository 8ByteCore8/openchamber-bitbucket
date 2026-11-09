import { HostRequestError, type HostClient } from '@openchamber/sdk';
import { t } from './i18n/index.ts';

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
  destination: { branch: { name: string }; commit?: { hash: string }; repository?: { full_name: string } };
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

const STRATEGY_KEYS = {
  merge_commit: 'strategy_merge_commit',
  squash: 'strategy_squash',
  fast_forward: 'strategy_fast_forward',
  squash_fast_forward: 'strategy_squash_fast_forward',
  rebase_fast_forward: 'strategy_rebase_fast_forward',
  rebase_merge: 'strategy_rebase_merge',
} as const;

/** A merge strategy in the current language; one Bitbucket adds later shows as is. */
export const strategyLabel = (strategy: string) =>
  strategy in STRATEGY_KEYS ? t(STRATEGY_KEYS[strategy as MergeStrategy]) : strategy;

export class BitbucketError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

type Page<T> = { values: T[]; next?: string; size?: number };

/** List answers may leave out participants and reviewers; the code reads them as arrays. */
const withLists = (pr: PullRequest): PullRequest => ({ ...pr, participants: pr.participants ?? [], reviewers: pr.reviewers ?? [] });

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
      return t('errTimeoutWrite');
    }
    if (error.code === 'DISCONNECTED') return t('errDisconnected');
    if (error.code === 'NOT_GRANTED') return t('errNotGranted');
    if (error.code === 'HOST_TIMEOUT') return t('errTimeout');
    return error.message;
  }
  if (error instanceof BitbucketError) {
    if (error.status === 403) return t('err403', { detail: error.message });
    if (error.status === 404) return t('err404');
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
      return page.values.map(withLists);
    },

    /** Slugs of the workspaces the user is a member of. */
    workspaces: async () => {
      const page = await json<Page<{ workspace: { slug: string } }>>('GET', '/user/workspaces', {
        query: { pagelen: '100', fields: 'values.workspace.slug' },
      });
      return page.values.map((entry) => entry.workspace.slug.toLowerCase());
    },

    /**
     * The user's open PRs in every repository of a workspace, in one call.
     * Bitbucket has no such endpoint for reviews: those are asked per repository.
     */
    myPullRequestsIn: async (workspace: string) => {
      const user = await getMe();
      const page = await json<Page<PullRequest>>('GET', `/workspaces/${encodeURIComponent(workspace)}/pullrequests/${encodeURIComponent(user.uuid)}`, {
        query: { q: 'state = "OPEN"', pagelen: '50', sort: '-updated_on', fields: '+values.participants,+values.reviewers' },
      });
      return page.values.map(withLists);
    },

    /** The open PR whose source is `branch`, or null. */
    pullRequestForBranch: async (repo: Repo, branch: string) => {
      const page = await json<Page<{ id: number }>>('GET', `${repoPath(repo)}/pullrequests`, {
        query: { q: `source.branch.name = ${quote(branch)} AND state = "OPEN"`, pagelen: '1', fields: 'values.id' },
      });
      const found = page.values[0];
      return found ? json<PullRequest>('GET', prPath(repo, found.id)) : null;
    },

    /** The open PR of `branch` as the list answers it (with participants), or null. One call. */
    branchPullRequest: async (repo: Repo, branch: string) => {
      const page = await json<Page<PullRequest>>('GET', `${repoPath(repo)}/pullrequests`, {
        query: { q: `source.branch.name = ${quote(branch)} AND state = "OPEN"`, pagelen: '1', fields: '+values.participants,+values.reviewers' },
      });
      const found = page.values[0];
      return found ? withLists(found) : null;
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
      if (!source || !destination) throw new BitbucketError(t('errNoCommits'), 0);
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

/** The repository a PR from a list belongs to, read from its destination. */
export const repoOfPullRequest = (pr: PullRequest): Repo | null => {
  const [workspace, slug, extra] = (pr.destination.repository?.full_name ?? '').toLowerCase().split('/');
  return workspace && slug && extra === undefined ? { workspace, slug } : null;
};

/** The state of the current user's review on a PR. */
export const myReview = (pr: PullRequest, uuid: string) => {
  const mine = pr.participants.find((participant) => participant.user.uuid === uuid);
  return { approved: Boolean(mine?.approved), changesRequested: mine?.state === 'changes_requested' };
};

export const reviewSummary = (pr: PullRequest) => ({
  approvals: pr.participants.filter((participant) => participant.approved).map((participant) => participant.user.display_name),
  changes: pr.participants.filter((participant) => participant.state === 'changes_requested').map((participant) => participant.user.display_name),
});

export type PipelineState = 'passed' | 'failed' | 'running' | 'stopped';

/** One state for the PR's commit statuses (Pipelines and other CI), worst first. */
export const pipelineSummary = (statuses: CommitStatus[]): { state: PipelineState; tone: 'success' | 'error' | 'info' | 'warning'; url?: string } | null => {
  if (statuses.length === 0) return null;
  const first = (state: CommitStatus['state']) => statuses.find((status) => status.state === state);
  const failed = first('FAILED');
  if (failed) return { state: 'failed', tone: 'error', url: failed.url };
  const running = first('INPROGRESS');
  if (running) return { state: 'running', tone: 'info', url: running.url };
  const stopped = first('STOPPED');
  if (stopped) return { state: 'stopped', tone: 'warning', url: stopped.url };
  return { state: 'passed', tone: 'success', url: statuses[0]?.url };
};

export const pipelineStateLabel = (state: PipelineState) => t(`pipeline_${state}`);

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
