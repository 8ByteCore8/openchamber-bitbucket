import { connectHost, type GuestStatusControl, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountEmpty, mountList, mountSpinner } from '@openchamber/sdk/ui';
import { createApi, describeError, repoKey, type CommitStatus, type PullRequest } from '../src/api.ts';
import { mountPrActions } from '../src/actions.ts';
import { mountCreateForm } from '../src/create.ts';
import { box, clear, el, installStyle } from '../src/dom.ts';
import { detectRepos, isDefaultBranch, localId, localLabel, pickKey, preferredRepo, type LocalRepo } from '../src/repo.ts';
import { renderPrCompact } from '../src/summary.ts';

// Work Status section: the PR of the branch checked out in the open project.
// It reads Bitbucket when it appears, when the project or the connection
// changes, and on "Обновить"; it never polls. Repository and "Обновить" go
// into the section header when the host supports header controls, so the
// body keeps to the PR itself.

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

new ResizeObserver(() => {
  void host.setHeight(Math.ceil(root.getBoundingClientRect().height)).catch(() => {});
}).observe(root);

const choose = (id: string) => {
  const next = repos.find((local) => localId(local) === id);
  if (!next) return;
  current = next;
  if (directory) void host.storage.set(pickKey(directory), id).catch(() => {});
  void showPullRequest();
};

// Registered synchronously, as the host requires.
host.onStatusControl(({ id, value }) => {
  if (id === 'refresh') void load();
  if (id === 'repo' && value) choose(value);
});

const publishControls = () => {
  if (!headerControls) return;
  const controls: GuestStatusControl[] = [];
  if (repos.length > 1 && current && repos.length <= 16) {
    controls.push({
      kind: 'select',
      id: 'repo',
      label: 'Репозиторий',
      value: localId(current),
      options: repos.map((local) => ({ value: localId(local), label: localLabel(local).slice(0, 60) })),
    });
  }
  controls.push({ kind: 'button', id: 'refresh', label: 'Обновить' });
  host.setStatusControls(controls).catch(() => {
    headerControls = false;
    void showPullRequest();
  });
};

/** Body entries for what the header would hold on hosts without header controls. */
const fallbackExtras = () => {
  const extras: { label: string; run: () => void }[] = [];
  if (repos.length > 1 && (!headerControls || repos.length > 16)) extras.push({ label: 'Репозиторий', run: showPicker });
  if (!headerControls) extras.push({ label: 'Обновить', run: () => void load() });
  return extras;
};

const showPicker = () => {
  generation++;
  clear(root);
  root.append(el('div', 'bb-small bb-muted', 'Какой репозиторий показывать в этом проекте:'));
  mountList(box(root), {
    ariaLabel: 'Репозитории проекта',
    items: repos.map((local) => ({ id: localId(local), title: localLabel(local), subtitle: repoKey(local.repo) })),
    selectedId: current ? localId(current) : undefined,
    onSelect: choose,
  });
  mountButton(box(root, 'bb-row'), { label: 'Назад', variant: 'ghost', size: 'xs', onClick: () => void showPullRequest() });
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

const showPullRequest = async () => {
  const mine = ++generation;
  clear(root);
  publishControls();
  const local = current;
  if (!local) return;
  const where = local.path ? `${local.path}: ` : '';
  if (!local.branch) {
    note(root, `${where}HEAD отсоединён. Все PR — в панели Bitbucket.`);
    return;
  }
  const body = box(root);
  mountSpinner(body, { size: 'sm', label: 'Ищу PR…' });
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
    mountBanner(body, { tone: 'error', title: 'Bitbucket не ответил', body: describeError(error), action: { label: 'Повторить', onClick: () => void showPullRequest() } });
    return;
  }
  if (mine !== generation) return;
  clear(body);
  if (!pr) {
    if (isDefaultBranch(local.branch)) note(body, `${where}${local.branch}, основная ветка: PR нет.`);
    else note(body, `${where}${local.branch}: PR нет.`, { label: 'Создать PR', run: showCreate });
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
      title: 'Bitbucket не подключён',
      body: 'Откройте Settings → Integrations → Bitbucket и введите email Atlassian и API-токен со скоупами Bitbucket.',
    });
    return;
  }
  if (!directory) {
    root.append(el('div', 'bb-small bb-muted', 'Откройте проект, чтобы увидеть PR его ветки.'));
    return;
  }
  mountSpinner(root, { size: 'sm', label: 'Читаю репозиторий…' });
  let found: string | null;
  try {
    ({ repos, note: found } = await detectRepos(host));
  } catch (error) {
    if (mine !== generation) return;
    clear(root);
    mountBanner(root, { tone: 'error', title: 'Не удалось прочитать git', body: describeError(error) });
    return;
  }
  if (mine !== generation) return;
  if (repos.length === 0) {
    clear(root);
    current = null;
    publishControls();
    root.append(el('div', 'bb-small bb-muted', found ?? 'Репозиторий Bitbucket не найден.'));
    return;
  }
  const saved = await host.storage.get(pickKey(directory)).catch(() => undefined);
  if (mine !== generation) return;
  current = repos.find((local) => localId(local) === saved) ?? preferredRepo(repos);
  await showPullRequest();
};

const onContext = (context: HostReadyContext) => {
  headerControls = Boolean(context.features?.statusControls);
  const nextDirectory = context.directory ?? null;
  const nextConnected = context.connection.connected;
  if (mounted && nextDirectory === directory && nextConnected === connected) return;
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
