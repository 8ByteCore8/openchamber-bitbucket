import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountBadge,
  mountButton,
  mountEmpty,
  mountList,
  mountSearchField,
  mountSelect,
  mountSpinner,
  mountTabs,
  mountText,
  mountTextField,
} from '@openchamber/sdk/ui';
import {
  createApi,
  describeError,
  repoKey,
  repoOfPullRequest,
  say,
  type Comment,
  type CommitStatus,
  type PullRequest,
  type Repo,
  type User,
} from '../src/api.ts';
import { mountPrActions } from '../src/actions.ts';
import { mountCreateForm } from '../src/create.ts';
import { box, clear, el, installStyle, renderDiff } from '../src/dom.ts';
import { isolate, relativeTime, setLocale, t } from '../src/i18n/index.ts';
import { detectRepos, isDefaultBranch, localId, localLabel, pickKey, preferredRepo, type LocalRepo } from '../src/repo.ts';
import { renderPrSummary } from '../src/summary.ts';

// Rail panel: the open PRs of a repository (mine, awaiting my review, all),
// of every repository of the project at once, or the user's own PRs across
// all workspaces; one PR in detail (description, diff, comments, reviewers, edit), and the
// new PR form. Reads happen on open, on a switch and on "Refresh" only.
// Text follows OpenChamber's language.

const host = connectHost();
const api = createApi(host);
const root = document.querySelector<HTMLElement>('#root')!;
root.style.padding = '10px 12px';
root.className = 'bb-stack';
installStyle();

type Filter = 'mine' | 'review' | 'open';
type Choice = { id: string; repo: Repo; local: LocalRepo | null };
/** One repository, every repository of the project, or the user's PRs in all workspaces. */
type Scope = 'repo' | 'project' | 'account';
type Row = { repo: Repo; pr: PullRequest };

const MANUAL_KEY = 'manual-repos';
const OTHER = '__other__';
const PROJECT = '__project__';
const ACCOUNT = '__account__';
/** Kept apart from the repository pick, which the Work Status section shares. */
const scopeKey = (dir: string) => pickKey(dir).replace(/^repo:/, 'scope:');

let mounted = false;
let directory: string | null = null;
let connected = false;
let generation = 0;
let choices: Choice[] = [];
let current: Choice | null = null;
let scope: Scope = 'repo';
let filter: Filter = 'mine';
let search = '';
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const openUrl = (url: string) => void host.openUrl(url);
const parseRepo = (text: string): Repo | null => {
  const match = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(text);
  return match?.[1] && match[2] ? { workspace: match[1].toLowerCase(), slug: match[2].toLowerCase() } : null;
};

/* ---------- repository choice ---------- */

const localChoices = () => choices.filter((choice) => choice.local);

const setScope = (next: Scope) => {
  scope = next;
  if (directory) void host.storage.set(scopeKey(directory), next).catch(() => {});
};

const repoBar = (parent: HTMLElement) => {
  const row = box(parent, 'bb-row');
  const holder = box(row, 'bb-grow');
  const locals = localChoices().length;
  mountSelect(holder, {
    value: scope === 'project' ? PROJECT : scope === 'account' ? ACCOUNT : current?.id ?? null,
    placeholder: t('repository'),
    searchable: choices.length > 6,
    options: [
      ...(locals > 1 ? [{ id: PROJECT, label: t('scopeProject', { count: locals }), hint: t('scopeProjectHint') }] : []),
      { id: ACCOUNT, label: t('scopeAccount'), hint: t('scopeAccountHint') },
      ...choices.map((choice) => ({
        id: choice.id,
        label: choice.local ? localLabel(choice.local) : repoKey(choice.repo),
        hint: choice.local ? repoKey(choice.repo) : t('addedByHand'),
      })),
      { id: OTHER, label: t('otherRepo') },
    ],
    onChange: (id) => {
      if (id === OTHER) {
        showManual();
        return;
      }
      if (id === PROJECT || id === ACCOUNT) {
        setScope(id === PROJECT ? 'project' : 'account');
        void showList();
        return;
      }
      current = choices.find((choice) => choice.id === id) ?? current;
      setScope('repo');
      if (directory && current?.local) void host.storage.set(pickKey(directory), current.id).catch(() => {});
      void showList();
    },
  });
  if (scope === 'repo') mountButton(row, { label: t('newPr'), size: 'sm', variant: 'outline', onClick: showCreate });
  mountButton(row, { label: t('refresh'), size: 'sm', variant: 'ghost', onClick: () => void load() });
};

const showManual = () => {
  generation++;
  clear(root);
  root.append(el('div', 'bb-h', t('bitbucketRepo')));
  let value = '';
  const field = mountTextField(box(root), {
    label: t('repoField'),
    value,
    mono: true,
    placeholder: 'my-workspace/my-repo',
    onChange: (next) => { value = next; field.update({ value: next, error: undefined }); },
  });
  const row = box(root, 'bb-row');
  mountButton(row, {
    label: t('open'),
    size: 'sm',
    onClick: async () => {
      const repo = parseRepo(value);
      if (!repo) {
        field.update({ error: t('repoFormat') });
        return;
      }
      const id = `manual|${repoKey(repo)}`;
      if (!choices.some((choice) => choice.id === id)) {
        choices.push({ id, repo, local: null });
        const manual = choices.filter((choice) => !choice.local).map((choice) => repoKey(choice.repo));
        await host.storage.set(MANUAL_KEY, manual).catch(() => {});
      }
      current = choices.find((choice) => choice.id === id) ?? null;
      setScope('repo');
      void showList();
    },
  });
  if (choices.length > 0) mountButton(row, { label: t('back'), size: 'sm', variant: 'ghost', onClick: () => void showList() });
  else mountButton(row, { label: t('scopeAccount'), size: 'sm', variant: 'ghost', onClick: () => { setScope('account'); void showList(); } });
};

/* ---------- list ---------- */

/** PRs of the scope, newest first, and the repositories that did not answer. */
const fetchRows = async (choice: Choice | null): Promise<{ rows: Row[]; failed: string[]; error: unknown }> => {
  if (scope === 'repo') {
    const repo = choice!.repo;
    const prs = await api.listPullRequests(repo, filter, search.trim());
    return { rows: prs.map((pr) => ({ repo, pr })), failed: [], error: null };
  }
  // One request per repository (or workspace), side by side; one that fails
  // is named under the list instead of hiding the others.
  const targets = scope === 'project'
    ? localChoices().map((choice) => ({ label: rowLabel(choice.repo), load: () => api.listPullRequests(choice.repo, filter) }))
    : (await api.workspaces()).map((workspace) => ({ label: workspace, load: () => api.myPullRequestsIn(workspace) }));
  const results = await Promise.allSettled(targets.map((target) => target.load()));
  const rows: Row[] = [];
  const failed: string[] = [];
  let error: unknown = null;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed.push(targets[index]!.label);
      error ??= result.reason;
      return;
    }
    for (const pr of result.value) {
      const repo = repoOfPullRequest(pr);
      if (repo) rows.push({ repo, pr });
    }
  });
  if (rows.length === 0 && failed.length === targets.length && error) throw error;
  rows.sort((a, b) => b.pr.updated_on.localeCompare(a.pr.updated_on));
  return { rows, failed, error };
};

/** The submodule path for a project repository, else the repository's slug. */
const rowLabel = (repo: Repo) => {
  const local = choices.find((choice) => choice.local && repoKey(choice.repo) === repoKey(repo))?.local;
  return local?.path || repo.slug;
};

const showList = async () => {
  const mine = ++generation;
  clear(root);
  if (scope === 'project' && localChoices().length < 2) scope = 'repo';
  if (scope === 'repo' && !current) {
    showManual();
    return;
  }
  const choice = current;
  const many = scope !== 'repo';
  repoBar(root);
  if (scope !== 'account') {
    const tabs = mountTabs(box(root), {
      activeId: filter,
      items: [
        { id: 'mine', label: t('tabMine') },
        { id: 'review', label: t('tabReview') },
        { id: 'open', label: t('tabOpen') },
      ],
      onChange: (id) => {
        filter = id as Filter;
        tabs.update({ activeId: filter });
        void fill();
      },
    });
  }
  mountSearchField(box(root), {
    value: search,
    placeholder: t('searchTitle'),
    onChange: (value) => {
      search = value;
      clearTimeout(searchTimer);
      // Many repositories: filter what is loaded instead of asking each again.
      if (many) draw();
      else searchTimer = setTimeout(() => void fill(), 400);
    },
  });
  const listRoot = box(root);
  const effective = (): Filter => (scope === 'account' ? 'mine' : filter);
  let loaded: { rows: Row[]; failed: string[] } = { rows: [], failed: [] };

  const draw = () => {
    clear(listRoot);
    const query = search.trim().toLowerCase();
    const rows = many && query
      ? loaded.rows.filter((row) => `${row.pr.title}\n${rowLabel(row.repo)}`.toLowerCase().includes(query))
      : loaded.rows;
    if (rows.length === 0) {
      const which = effective();
      const why = search ? t('emptySearch')
        : scope === 'account' ? t('emptyMineAccount')
        : which === 'review' ? t('emptyReview')
        : scope === 'project' ? (which === 'mine' ? t('emptyMineProject') : t('emptyOpenProject'))
        : which === 'mine' ? t('emptyMine') : t('emptyOpen');
      mountEmpty(listRoot, { title: t('noPrs'), body: why, action: many ? undefined : { label: t('createPr'), onClick: showCreate } });
    } else {
      const byId = new Map(rows.map((row) => [`${repoKey(row.repo)}#${row.pr.id}`, row]));
      const showAuthor = effective() !== 'mine';
      mountList(listRoot, {
        ariaLabel: t('pullRequests'),
        items: [...byId].map(([id, { repo, pr }]) => ({
          id,
          title: `#${pr.id} ${pr.title}`,
          subtitle: [
            many ? isolate(rowLabel(repo)) : null,
            isolate(`${pr.source.branch.name} → ${pr.destination.branch.name}`),
            showAuthor ? pr.author.display_name : null,
          ].filter(Boolean).join(' · '),
          meta: relativeTime(pr.updated_on),
          badge: pr.draft
            ? { label: t('listDraft'), tone: 'neutral' as const }
            : pr.participants.some((participant) => participant.state === 'changes_requested')
              ? { label: t('listChanges'), tone: 'warning' as const }
              : pr.participants.some((participant) => participant.approved)
                ? { label: t('listApproved'), tone: 'success' as const }
                : undefined,
        })),
        onSelect: (id) => {
          const row = byId.get(id);
          if (row) void showDetail(row.repo, row.pr.id);
        },
      });
    }
    if (loaded.failed.length > 0) listRoot.append(el('div', 'bb-small bb-muted', t('notLoaded', { repos: loaded.failed.join(', ') })));
  };

  const fill = async () => {
    const mineFill = ++generation;
    clear(listRoot);
    mountSpinner(listRoot, { size: 'sm', label: t('loadingPrs') });
    try {
      const result = await fetchRows(choice);
      if (mineFill !== generation) return;
      loaded = result;
      draw();
    } catch (error) {
      if (mineFill !== generation) return;
      clear(listRoot);
      mountBanner(listRoot, { tone: 'error', title: t('loadPrsFailed'), body: describeError(error), action: { label: t('retry'), onClick: () => void fill() } });
    }
  };
  if (mine === generation) await fill();
};

/* ---------- detail ---------- */

type DetailTab = 'about' | 'diff' | 'comments' | 'reviewers';

const showDetail = async (repo: Repo, id: number, tab: DetailTab = 'about') => {
  const mine = ++generation;
  clear(root);
  const top = box(root, 'bb-row');
  mountButton(top, { label: t('backToList'), size: 'sm', variant: 'ghost', onClick: () => void showList() });
  top.append(el('div', 'bb-grow'));
  mountButton(top, { label: t('refresh'), size: 'sm', variant: 'ghost', onClick: () => void showDetail(repo, id, active) });
  const body = box(root, 'bb-stack');
  mountSpinner(body, { size: 'sm', label: t('loadingPr', { id }) });

  let active: DetailTab = tab;
  let pr: PullRequest;
  let statuses: CommitStatus[] | null;
  let meUuid: string;
  try {
    const [loaded, found, me] = await Promise.all([
      api.pullRequest(repo, id),
      api.statuses(repo, id).catch(() => null),
      api.me(),
    ]);
    pr = loaded;
    statuses = found;
    meUuid = me.uuid;
  } catch (error) {
    if (mine !== generation) return;
    clear(body);
    mountBanner(body, { tone: 'error', title: t('prLoadFailed', { id }), body: describeError(error), action: { label: t('retry'), onClick: () => void showDetail(repo, id, tab) } });
    return;
  }
  if (mine !== generation) return;
  clear(body);
  renderPrSummary(body, host, pr, statuses);
  mountPrActions(body, { host, api, repo, pr, meUuid, onChanged: () => void showDetail(repo, id, active) });

  const tabs = mountTabs(box(body), {
    activeId: active,
    items: [
      { id: 'about', label: t('description') },
      { id: 'diff', label: t('tabDiff') },
      { id: 'comments', label: t('tabComments'), count: pr.comment_count || undefined },
      { id: 'reviewers', label: t('tabReviewers'), count: pr.reviewers.length || undefined },
    ],
    onChange: (next) => {
      active = next as DetailTab;
      tabs.update({ activeId: active });
      show();
    },
  });
  const panes: Record<DetailTab, HTMLElement> = {
    about: box(body, 'bb-stack'),
    diff: box(body, 'bb-stack'),
    comments: box(body, 'bb-stack'),
    reviewers: box(body, 'bb-stack'),
  };
  const drawn = new Set<DetailTab>();
  const show = () => {
    for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== active;
    if (drawn.has(active)) return;
    drawn.add(active);
    if (active === 'about') drawAbout(panes.about, repo, pr, () => void showDetail(repo, id, 'about'));
    if (active === 'diff') void drawDiff(panes.diff, repo, pr);
    if (active === 'comments') void drawComments(panes.comments, repo, pr, () => void showDetail(repo, id, 'comments'));
    if (active === 'reviewers') void drawReviewers(panes.reviewers, repo, pr, () => void showDetail(repo, id, 'reviewers'));
  };
  show();
};

const drawAbout = (pane: HTMLElement, repo: Repo, pr: PullRequest, reload: () => void) => {
  clear(pane);
  const text = box(pane, 'bb-card');
  if (pr.description.trim()) mountText(text, { text: pr.description, onOpenUrl: openUrl });
  else text.append(el('div', 'bb-muted', t('noDescription')));
  if (pr.state !== 'OPEN') return;
  mountButton(box(pane, 'bb-row'), {
    label: t('editTitleDescription'),
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      clear(pane);
      const draft = { title: pr.title, description: pr.description };
      const title = mountTextField(box(pane), { label: t('title'), value: draft.title, onChange: (value) => { draft.title = value; title.update({ value }); } });
      const description = mountTextField(box(pane), {
        label: t('description'),
        value: draft.description,
        multiline: true,
        rows: 10,
        onChange: (value) => { draft.description = value; description.update({ value }); },
      });
      const errorRoot = box(pane);
      const row = box(pane, 'bb-row');
      const save = mountButton(row, {
        label: t('save'),
        size: 'sm',
        onClick: async () => {
          if (!draft.title.trim()) {
            title.update({ error: t('titleEmpty') });
            return;
          }
          save.update({ loading: true, disabled: true });
          try {
            await api.updatePullRequest(repo, pr, { title: draft.title.trim(), description: draft.description });
            await say(host, 'success', t('updated', { id: pr.id }));
            reload();
          } catch (error) {
            save.update({ loading: false, disabled: false });
            clear(errorRoot);
            mountBanner(errorRoot, { tone: 'error', title: t('notSaved'), body: describeError(error, { write: true }) });
          }
        },
      });
      mountButton(row, { label: t('cancel'), size: 'sm', variant: 'ghost', onClick: () => drawAbout(pane, repo, pr, reload) });
    },
  });
};

const drawDiff = async (pane: HTMLElement, repo: Repo, pr: PullRequest) => {
  mountSpinner(pane, { size: 'sm', label: t('loadingDiff') });
  try {
    const diff = await api.diff(repo, pr);
    clear(pane);
    if (!diff.trim()) {
      pane.append(el('div', 'bb-muted', t('diffEmpty')));
      return;
    }
    renderDiff(pane, diff);
  } catch (error) {
    clear(pane);
    mountBanner(pane, { tone: 'error', title: t('diffFailed'), body: describeError(error) });
  }
};

const drawComments = async (pane: HTMLElement, repo: Repo, pr: PullRequest, reload: () => void) => {
  mountSpinner(pane, { size: 'sm', label: t('loadingComments') });
  let comments: Comment[];
  try {
    comments = await api.comments(repo, pr.id);
  } catch (error) {
    clear(pane);
    mountBanner(pane, { tone: 'error', title: t('commentsFailed'), body: describeError(error) });
    return;
  }
  clear(pane);
  const byParent = new Map<number | null, Comment[]>();
  const known = new Set(comments.map((comment) => comment.id));
  for (const comment of comments) {
    const parent = comment.parent && known.has(comment.parent.id) ? comment.parent.id : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), comment]);
  }
  const draw = (parent: number | null, depth: number) => {
    for (const comment of byParent.get(parent) ?? []) {
      const node = box(pane, depth > 0 ? 'bb-comment reply' : 'bb-comment');
      node.append(el('div', 'bb-small bb-muted', t('authorTime', { author: comment.user.display_name, time: relativeTime(comment.created_on) })));
      mountText(box(node), { text: comment.content.raw, onOpenUrl: openUrl });
      draw(comment.id, depth + 1);
    }
  };
  if (comments.length === 0) pane.append(el('div', 'bb-muted', t('noComments')));
  else draw(null, 0);

  let text = '';
  const field = mountTextField(box(pane), {
    label: t('newComment'),
    value: '',
    multiline: true,
    rows: 3,
    placeholder: t('markdown'),
    onChange: (value) => { text = value; field.update({ value }); },
  });
  const send = mountButton(box(pane, 'bb-row'), {
    label: t('send'),
    size: 'sm',
    onClick: async () => {
      if (!text.trim()) return;
      send.update({ loading: true, disabled: true });
      try {
        await api.comment(repo, pr.id, text.trim());
        await say(host, 'success', t('commentSent'));
        reload();
      } catch (error) {
        send.update({ loading: false, disabled: false });
        await say(host, 'error', describeError(error, { write: true }));
      }
    },
  });
};

const drawReviewers = async (pane: HTMLElement, repo: Repo, pr: PullRequest, reload: () => void) => {
  const chosen = new Map<string, string>(pr.reviewers.map((user) => [user.uuid, user.display_name]));
  const stateOf = (uuid: string) => {
    const participant = pr.participants.find((entry) => entry.user.uuid === uuid);
    if (participant?.approved) return { label: t('listApproved'), tone: 'success' as const };
    if (participant?.state === 'changes_requested') return { label: t('listChanges'), tone: 'warning' as const };
    return null;
  };
  const listRoot = box(pane, 'bb-stack');
  const addRoot = box(pane);
  const saveRoot = box(pane, 'bb-row');
  let members: User[] = [];

  const drawChosen = () => {
    clear(listRoot);
    if (chosen.size === 0) listRoot.append(el('div', 'bb-muted', t('noReviewers')));
    for (const [uuid, name] of chosen) {
      const row = box(listRoot, 'bb-row');
      row.append(el('div', 'bb-grow', name));
      const state = stateOf(uuid);
      if (state) mountBadge(row, state);
      if (pr.state === 'OPEN') mountButton(row, { label: t('remove'), size: 'xs', variant: 'ghost', onClick: () => { chosen.delete(uuid); drawChosen(); drawAdd(); } });
    }
  };
  const drawAdd = () => {
    clear(addRoot);
    if (pr.state !== 'OPEN' || members.length === 0) return;
    const options = members
      .filter((user) => user.uuid !== pr.author.uuid && !chosen.has(user.uuid))
      .map((user) => ({ id: user.uuid, label: user.display_name, hint: user.nickname }));
    if (options.length === 0) return;
    mountSelect(addRoot, {
      value: null,
      placeholder: t('addReviewer'),
      searchable: true,
      searchPlaceholder: t('name'),
      options,
      onChange: (uuid) => {
        const user = members.find((member) => member.uuid === uuid);
        if (user) chosen.set(user.uuid, user.display_name);
        drawChosen();
        drawAdd();
      },
    });
  };
  drawChosen();
  if (pr.state !== 'OPEN') return;
  const save = mountButton(saveRoot, {
    label: t('saveReviewers'),
    size: 'sm',
    onClick: async () => {
      save.update({ loading: true, disabled: true });
      try {
        await api.updatePullRequest(repo, pr, { reviewers: [...chosen.keys()] });
        await say(host, 'success', t('reviewersUpdated'));
        reload();
      } catch (error) {
        save.update({ loading: false, disabled: false });
        await say(host, 'error', describeError(error, { write: true }));
      }
    },
  });
  try {
    members = await api.members(repo);
    drawAdd();
  } catch (error) {
    mountBanner(addRoot, { tone: 'warning', title: t('membersUnavailable'), body: describeError(error) });
  }
};

/* ---------- create ---------- */

function showCreate() {
  if (!current) return;
  generation++;
  const choice = current;
  clear(root);
  const top = box(root, 'bb-row');
  mountButton(top, { label: t('backToList'), size: 'sm', variant: 'ghost', onClick: () => void showList() });
  root.append(el('div', 'bb-h', t('newPrIn', { repo: isolate(repoKey(choice.repo)) })));
  mountCreateForm(box(root), {
    host,
    api,
    repo: choice.repo,
    source: choice.local?.branch && !isDefaultBranch(choice.local.branch) ? choice.local.branch : null,
    onCreated: (pr) => void showDetail(choice.repo, pr.id),
    onCancel: () => void showList(),
  });
}

/* ---------- loading ---------- */

const load = async () => {
  const mine = ++generation;
  clear(root);
  if (!connected) {
    mountEmpty(root, {
      title: t('notConnectedTitle'),
      body: t('notConnectedBody'),
    });
    return;
  }
  mountSpinner(root, { size: 'sm', label: t('findingRepos') });
  const [detection, manual, saved, savedScope] = await Promise.all([
    directory ? detectRepos(host).catch(() => ({ repos: [], note: null })) : Promise.resolve({ repos: [] as LocalRepo[], note: null }),
    host.storage.get(MANUAL_KEY).catch(() => undefined),
    directory ? host.storage.get(pickKey(directory)).catch(() => undefined) : Promise.resolve(undefined),
    directory ? host.storage.get(scopeKey(directory)).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (mine !== generation) return;
  choices = detection.repos.map((local) => ({ id: localId(local), repo: local.repo, local }));
  for (const key of Array.isArray(manual) ? manual : []) {
    const repo = typeof key === 'string' ? parseRepo(key) : null;
    if (repo) choices.push({ id: `manual|${repoKey(repo)}`, repo, local: null });
  }
  const preferred = preferredRepo(detection.repos);
  current = choices.find((choice) => choice.id === saved)
    ?? choices.find((choice) => choice.local === preferred && preferred !== null)
    ?? choices[0]
    ?? null;
  // A project with submodules opens on all of its repositories.
  scope = savedScope === 'repo' || savedScope === 'project' || savedScope === 'account'
    ? savedScope
    : detection.repos.length > 1 ? 'project' : 'repo';
  await showList();
};

const onContext = (context: HostReadyContext) => {
  const languageChanged = setLocale(context.locale);
  const nextDirectory = context.directory ?? null;
  const nextConnected = context.connection.connected;
  if (mounted && !languageChanged && nextDirectory === directory && nextConnected === connected) return;
  mounted = true;
  directory = nextDirectory;
  connected = nextConnected;
  void load();
};

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  onContext(context);
});
host.onDirectory((next) => {
  if (!mounted || next === directory) return;
  directory = next;
  void load();
});
host.onConnection((connection) => {
  if (!mounted || connection.connected === connected) return;
  connected = connection.connected;
  void load();
});
