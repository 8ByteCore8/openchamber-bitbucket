import { connectHost, type GuestStatusControl, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountEmpty, mountList, mountSpinner } from '@openchamber/sdk/ui';
import { createApi, describeError, pipelineStateLabel, pipelineSummary, repoKey, reviewSummary, type CommitStatus, type PullRequest } from '../src/api.ts';
import { mountPrActions } from '../src/actions.ts';
import { mountCreateForm } from '../src/create.ts';
import { box, clear, el, installStyle } from '../src/dom.ts';
import { isolate, setLocale, t } from '../src/i18n/index.ts';
import { detectRepos, isDefaultBranch, localId, localLabel, pickKey, preferredRepo, type Detection, type LocalRepo } from '../src/repo.ts';
import { renderPrCompact, TONE_COLOR } from '../src/summary.ts';

// Work Status section: the PR of the branch checked out in the open project,
// or, in "Whole project" mode, one line per repository that is on a feature
// branch with that branch's PR; a click opens it here with the usual buttons.
// It reads Bitbucket when it appears, when the project or the connection
// changes, and on "Refresh"; it never polls. Repository and "Refresh" go
// into the section header when the host supports header controls, so the
// body keeps to the PR itself. Text follows OpenChamber's language.

const host = connectHost();
const api = createApi(host);
const root = document.querySelector<HTMLElement>('#root')!;
root.style.padding = '6px 10px 8px';
root.className = 'bb-stack';
installStyle();

let mounted = false;
let directory: string | null = null;
let connected = false;
let generation = 0;
let repos: LocalRepo[] = [];
let current: LocalRepo | null = null;
let headerControls = false;
/** "Whole project": the PRs of the branches checked out in every repository. */
let project = false;
/** A PR opened from the "Whole project" list: Back returns to the list. */
let fromProject = false;

const PROJECT = '__project__';
/** Separate from the repository pick, which the panel shares. */
const modeKey = (dir: string) => pickKey(dir).replace(/^repo:/, 'status:');
/** The host allows 16 options; "Whole project" takes one. */
const SELECT_MAX = 15;

new ResizeObserver(() => {
  void host.setHeight(Math.ceil(root.getBoundingClientRect().height)).catch(() => {});
}).observe(root);

const setProject = (on: boolean) => {
  project = on;
  if (directory) void host.storage.set(modeKey(directory), on ? 'project' : 'repo').catch(() => {});
};

const choose = (id: string) => {
  if (id === PROJECT) {
    setProject(true);
    void showProject();
    return;
  }
  const next = repos.find((local) => localId(local) === id);
  if (!next) return;
  current = next;
  fromProject = false;
  setProject(false);
  if (directory) void host.storage.set(pickKey(directory), id).catch(() => {});
  void showPullRequest();
};

// Registered synchronously, as the host requires.
host.onStatusControl(({ id, value }) => {
  if (id === 'refresh') void (fromProject ? showPullRequest() : load());
  if (id === 'repo' && value) choose(value);
});

const publishControls = () => {
  if (!headerControls) return;
  const controls: GuestStatusControl[] = [];
  if (repos.length > 1 && current && repos.length <= SELECT_MAX) {
    controls.push({
      kind: 'select',
      id: 'repo',
      label: t('repository'),
      value: project ? PROJECT : localId(current),
      options: [
        { value: PROJECT, label: t('scopeProject', { count: repos.length }).slice(0, 60) },
        ...repos.map((local) => ({ value: localId(local), label: localLabel(local).slice(0, 60) })),
      ],
    });
  }
  controls.push({ kind: 'button', id: 'refresh', label: t('refresh') });
  host.setStatusControls(controls).catch(() => {
    headerControls = false;
    void (project && !fromProject ? showProject() : showPullRequest());
  });
};

/** Body entries for what the header would hold on hosts without header controls. */
const fallbackExtras = () => {
  const extras: { label: string; run: () => void }[] = [];
  if (repos.length > 1 && (!headerControls || repos.length > SELECT_MAX)) extras.push({ label: t('repository'), run: showPicker });
  if (!headerControls) extras.push({ label: t('refresh'), run: () => void load() });
  return extras;
};

const showPicker = () => {
  generation++;
  clear(root);
  root.append(el('div', 'bb-small bb-muted', t('pickRepo')));
  mountList(box(root), {
    ariaLabel: t('projectRepos'),
    items: [
      { id: PROJECT, title: t('scopeProject', { count: repos.length }), subtitle: t('scopeProjectHint') },
      ...repos.map((local) => ({ id: localId(local), title: localLabel(local), subtitle: repoKey(local.repo) })),
    ],
    selectedId: project ? PROJECT : current ? localId(current) : undefined,
    onSelect: choose,
  });
  mountButton(box(root, 'bb-row'), { label: t('back'), variant: 'ghost', size: 'xs', onClick: () => void (project && !fromProject ? showProject() : showPullRequest()) });
};

const showCreate = () => {
  if (!current?.branch) return;
  generation++;
  clear(root);
  mountCreateForm(box(root), {
    host,
    api,
    repo: current.repo,
    source: current.branch,
    onCreated: () => void showPullRequest(),
    onCancel: () => void showPullRequest(),
  });
};

/** A one-line message with the fallback buttons beside it. */
const note = (parent: HTMLElement, text: string, action?: { label: string; run: () => void }) => {
  const row = box(parent, 'bb-row');
  row.append(el('div', 'bb-grow bb-small bb-muted', text));
  if (action) mountButton(row, { label: action.label, size: 'xs', variant: 'outline', onClick: action.run });
  for (const extra of fallbackExtras()) mountButton(row, { label: extra.label, size: 'xs', variant: 'ghost', onClick: extra.run });
};

/** One line per repository on a feature branch: pipeline, where, PR; the rest are counted. */
const showProject = async () => {
  const mine = ++generation;
  fromProject = false;
  clear(root);
  publishControls();
  const working = repos.filter((local) => local.branch && !isDefaultBranch(local.branch));
  const resting = repos.length - working.length;
  if (working.length === 0) {
    note(root, t('projectNothing'));
    return;
  }
  const list = box(root, 'bb-stack');
  list.style.gap = '2px';
  mountSpinner(list, { size: 'sm', label: t('findingPr') });
  const results = await Promise.allSettled(working.map(async (local) => {
    const pr = await api.branchPullRequest(local.repo, local.branch!);
    const statuses = pr ? await api.statuses(local.repo, pr.id).catch(() => null) : null;
    return { pr, statuses };
  }));
  if (mine !== generation) return;
  clear(list);
  results.forEach((result, index) => {
    const local = working[index]!;
    const row = box(list, 'bb-row bb-small bb-click');
    row.style.flexWrap = 'nowrap';
    const span = (text: string, className?: string, color?: string) => {
      const node = row.appendChild(el('span', className, text));
      if (color) node.style.color = color;
      return node;
    };
    const where = isolate(local.path || local.repo.slug);
    if (result.status === 'rejected') {
      span(where, 'bb-muted');
      span(t('noAnswer'), 'bb-ellipsis', TONE_COLOR.error).title = describeError(result.reason);
    } else if (!result.value.pr) {
      span(where, 'bb-muted');
      span(`${isolate(local.branch!)} · ${t('noPrShort')}`, 'bb-ellipsis bb-muted');
    } else {
      const { pr, statuses } = result.value;
      const pipeline = statuses ? pipelineSummary(statuses) : null;
      const dot = span('●', undefined, pipeline ? TONE_COLOR[pipeline.tone] : 'var(--oc-muted)');
      dot.title = pipeline ? t('pipeline', { state: pipelineStateLabel(pipeline.state) }) : '';
      span(where, 'bb-muted');
      span(`#${pr.id} ${pr.title}`, 'bb-grow bb-ellipsis').title = pr.title;
      const { approvals, changes } = reviewSummary(pr);
      if (changes.length > 0) span(`✗ ${changes.length}`, undefined, TONE_COLOR.warning).title = t('changesBy', { names: changes.join(', ') });
      if (approvals.length > 0) span(`✓ ${approvals.length}`, undefined, TONE_COLOR.success).title = t('approvedBy', { names: approvals.join(', ') });
      if (pr.draft) span(t('listDraft'), 'bb-muted');
    }
    row.addEventListener('click', () => {
      current = local;
      fromProject = true;
      void showPullRequest();
    });
  });
  if (resting > 0 || fallbackExtras().length > 0) note(root, resting > 0 ? t('projectOnMain', { count: resting }) : '');
};

const showPullRequest = async () => {
  const mine = ++generation;
  clear(root);
  publishControls();
  const local = current;
  if (!local) return;
  if (fromProject) {
    mountButton(box(root, 'bb-row'), { label: `← ${t('scopeProject', { count: repos.length })}`, variant: 'ghost', size: 'xs', onClick: () => void showProject() });
  }
  const where = local.path ? `${isolate(local.path)}: ` : '';
  if (!local.branch) {
    note(root, `${where}${t('detached')}`);
    return;
  }
  const body = box(root);
  mountSpinner(body, { size: 'sm', label: t('findingPr') });
  let pr: PullRequest | null;
  let statuses: CommitStatus[] | null = null;
  let meUuid = '';
  try {
    pr = await api.pullRequestForBranch(local.repo, local.branch);
    if (pr) {
      const [found, me] = await Promise.all([api.statuses(local.repo, pr.id).catch(() => null), api.me()]);
      statuses = found;
      meUuid = me.uuid;
    }
  } catch (error) {
    if (mine !== generation) return;
    clear(body);
    mountBanner(body, { tone: 'error', title: t('noAnswer'), body: describeError(error), action: { label: t('retry'), onClick: () => void showPullRequest() } });
    return;
  }
  if (mine !== generation) return;
  clear(body);
  if (!pr) {
    const branch = isolate(local.branch);
    if (isDefaultBranch(local.branch)) note(body, `${where}${t('mainBranchNoPr', { branch })}`);
    else note(body, `${where}${t('noPr', { branch })}`, { label: t('createPr'), run: showCreate });
    return;
  }
  const card = box(body, 'bb-stack');
  card.style.gap = '6px';
  renderPrCompact(card, host, local.repo, pr, statuses, meUuid);
  mountPrActions(card, { host, api, repo: local.repo, pr, meUuid, compact: true, extra: fallbackExtras(), onChanged: () => void showPullRequest() });
};

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
  if (!directory) {
    root.append(el('div', 'bb-small bb-muted', t('openProject')));
    return;
  }
  mountSpinner(root, { size: 'sm', label: t('readingRepo') });
  let found: Detection['note'];
  try {
    ({ repos, note: found } = await detectRepos(host));
  } catch (error) {
    if (mine !== generation) return;
    clear(root);
    mountBanner(root, { tone: 'error', title: t('gitReadFailed'), body: describeError(error) });
    return;
  }
  if (mine !== generation) return;
  if (repos.length === 0) {
    clear(root);
    current = null;
    publishControls();
    root.append(el('div', 'bb-small bb-muted', t(found ?? 'noRepo')));
    return;
  }
  const [saved, mode] = await Promise.all([
    host.storage.get(pickKey(directory)).catch(() => undefined),
    host.storage.get(modeKey(directory)).catch(() => undefined),
  ]);
  if (mine !== generation) return;
  current = repos.find((local) => localId(local) === saved) ?? preferredRepo(repos);
  project = mode === 'project' && repos.length > 1;
  fromProject = false;
  await (project ? showProject() : showPullRequest());
};

const onContext = (context: HostReadyContext) => {
  headerControls = Boolean(context.features?.statusControls);
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
