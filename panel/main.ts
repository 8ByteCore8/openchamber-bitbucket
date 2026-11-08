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
  say,
  type Comment,
  type CommitStatus,
  type PullRequest,
  type Repo,
  type User,
} from '../src/api.ts';
import { mountPrActions } from '../src/actions.ts';
import { mountCreateForm } from '../src/create.ts';
import { box, clear, el, installStyle, relativeTime, renderDiff } from '../src/dom.ts';
import { detectRepos, isDefaultBranch, localId, localLabel, pickKey, preferredRepo, type LocalRepo } from '../src/repo.ts';
import { renderPrSummary } from '../src/summary.ts';

// Rail panel: the open PRs of a repository (mine, awaiting my review, all),
// one PR in detail (description, diff, comments, reviewers, edit), and the
// new PR form. Reads happen on open, on a switch and on "Обновить" only.

const host = connectHost();
const api = createApi(host);
const root = document.querySelector<HTMLElement>('#root')!;
root.style.padding = '10px 12px';
root.className = 'bb-stack';
installStyle();

type Filter = 'mine' | 'review' | 'open';
type Choice = { id: string; repo: Repo; local: LocalRepo | null };

const MANUAL_KEY = 'manual-repos';
const OTHER = '__other__';

let mounted = false;
let directory: string | null = null;
let connected = false;
let generation = 0;
let choices: Choice[] = [];
let current: Choice | null = null;
let filter: Filter = 'mine';
let search = '';
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const openUrl = (url: string) => void host.openUrl(url);
const parseRepo = (text: string): Repo | null => {
  const match = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(text);
  return match?.[1] && match[2] ? { workspace: match[1].toLowerCase(), slug: match[2].toLowerCase() } : null;
};

/* ---------- repository choice ---------- */

const repoBar = (parent: HTMLElement) => {
  const row = box(parent, 'bb-row');
  const holder = box(row, 'bb-grow');
  mountSelect(holder, {
    value: current?.id ?? null,
    placeholder: 'Репозиторий',
    searchable: choices.length > 6,
    options: [
      ...choices.map((choice) => ({
        id: choice.id,
        label: choice.local ? localLabel(choice.local) : repoKey(choice.repo),
        hint: choice.local ? repoKey(choice.repo) : 'добавлен вручную',
      })),
      { id: OTHER, label: 'Другой репозиторий…' },
    ],
    onChange: (id) => {
      if (id === OTHER) {
        showManual();
        return;
      }
      current = choices.find((choice) => choice.id === id) ?? current;
      if (directory && current?.local) void host.storage.set(pickKey(directory), current.id).catch(() => {});
      void showList();
    },
  });
  mountButton(row, { label: 'Новый PR', size: 'sm', variant: 'outline', onClick: showCreate });
  mountButton(row, { label: 'Обновить', size: 'sm', variant: 'ghost', onClick: () => void load() });
};

const showManual = () => {
  generation++;
  clear(root);
  root.append(el('div', 'bb-h', 'Репозиторий Bitbucket'));
  let value = '';
  const field = mountTextField(box(root), {
    label: 'workspace/repo',
    value,
    mono: true,
    placeholder: 'my-workspace/my-repo',
    onChange: (next) => { value = next; field.update({ value: next, error: undefined }); },
  });
  const row = box(root, 'bb-row');
  mountButton(row, {
    label: 'Открыть',
    size: 'sm',
    onClick: async () => {
      const repo = parseRepo(value);
      if (!repo) {
        field.update({ error: 'Нужен вид workspace/repo' });
        return;
      }
      const id = `manual|${repoKey(repo)}`;
      if (!choices.some((choice) => choice.id === id)) {
        choices.push({ id, repo, local: null });
        const manual = choices.filter((choice) => !choice.local).map((choice) => repoKey(choice.repo));
        await host.storage.set(MANUAL_KEY, manual).catch(() => {});
      }
      current = choices.find((choice) => choice.id === id) ?? null;
      void showList();
    },
  });
  if (choices.length > 0) mountButton(row, { label: 'Назад', size: 'sm', variant: 'ghost', onClick: () => void showList() });
};

/* ---------- list ---------- */

const showList = async () => {
  const mine = ++generation;
  clear(root);
  if (!current) {
    showManual();
    return;
  }
  const repo = current.repo;
  repoBar(root);
  const tabsRoot = box(root);
  const tabs = mountTabs(tabsRoot, {
    activeId: filter,
    items: [
      { id: 'mine', label: 'Мои' },
      { id: 'review', label: 'Жду ревью' },
      { id: 'open', label: 'Все открытые' },
    ],
    onChange: (id) => {
      filter = id as Filter;
      tabs.update({ activeId: filter });
      void fill();
    },
  });
  mountSearchField(box(root), {
    value: search,
    placeholder: 'Поиск по заголовку',
    onChange: (value) => {
      search = value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void fill(), 400);
    },
  });
  const listRoot = box(root);

  const fill = async () => {
    const mineFill = ++generation;
    clear(listRoot);
    mountSpinner(listRoot, { size: 'sm', label: 'Загружаю PR…' });
    try {
      const prs = await api.listPullRequests(repo, filter, search.trim());
      if (mineFill !== generation) return;
      clear(listRoot);
      if (prs.length === 0) {
        const why = search ? 'Ничего не нашлось по этому запросу.'
          : filter === 'mine' ? 'У вас нет открытых PR в этом репозитории.'
          : filter === 'review' ? 'Никто не ждёт вашего ревью.'
          : 'В репозитории нет открытых PR.';
        mountEmpty(listRoot, { title: 'Нет PR', body: why, action: { label: 'Создать PR', onClick: showCreate } });
        return;
      }
      mountList(listRoot, {
        ariaLabel: 'Pull requests',
        items: prs.map((pr) => ({
          id: String(pr.id),
          title: `#${pr.id} ${pr.title}`,
          subtitle: `${pr.source.branch.name} → ${pr.destination.branch.name} · ${pr.author.display_name}`,
          meta: relativeTime(pr.updated_on),
          badge: pr.draft
            ? { label: 'черновик', tone: 'neutral' as const }
            : pr.participants.some((participant) => participant.state === 'changes_requested')
              ? { label: 'правки', tone: 'warning' as const }
              : pr.participants.some((participant) => participant.approved)
                ? { label: 'approve', tone: 'success' as const }
                : undefined,
        })),
        onSelect: (id) => void showDetail(repo, Number(id)),
      });
    } catch (error) {
      if (mineFill !== generation) return;
      clear(listRoot);
      mountBanner(listRoot, { tone: 'error', title: 'Не удалось загрузить PR', body: describeError(error), action: { label: 'Повторить', onClick: () => void fill() } });
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
  mountButton(top, { label: '← К списку', size: 'sm', variant: 'ghost', onClick: () => void showList() });
  top.append(el('div', 'bb-grow'));
  mountButton(top, { label: 'Обновить', size: 'sm', variant: 'ghost', onClick: () => void showDetail(repo, id, active) });
  const body = box(root, 'bb-stack');
  mountSpinner(body, { size: 'sm', label: `Загружаю PR #${id}…` });

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
    mountBanner(body, { tone: 'error', title: `PR #${id} не загрузился`, body: describeError(error), action: { label: 'Повторить', onClick: () => void showDetail(repo, id, tab) } });
    return;
  }
  if (mine !== generation) return;
  clear(body);
  renderPrSummary(body, host, pr, statuses);
  mountPrActions(body, { host, api, repo, pr, meUuid, onChanged: () => void showDetail(repo, id, active) });

  const tabs = mountTabs(box(body), {
    activeId: active,
    items: [
      { id: 'about', label: 'Описание' },
      { id: 'diff', label: 'Дифф' },
      { id: 'comments', label: 'Комментарии', count: pr.comment_count || undefined },
      { id: 'reviewers', label: 'Ревьюеры', count: pr.reviewers.length || undefined },
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
  else text.append(el('div', 'bb-muted', 'Описания нет.'));
  if (pr.state !== 'OPEN') return;
  mountButton(box(pane, 'bb-row'), {
    label: 'Изменить заголовок и описание',
    size: 'sm',
    variant: 'outline',
    onClick: () => {
      clear(pane);
      const draft = { title: pr.title, description: pr.description };
      const title = mountTextField(box(pane), { label: 'Заголовок', value: draft.title, onChange: (value) => { draft.title = value; title.update({ value }); } });
      const description = mountTextField(box(pane), {
        label: 'Описание',
        value: draft.description,
        multiline: true,
        rows: 10,
        onChange: (value) => { draft.description = value; description.update({ value }); },
      });
      const errorRoot = box(pane);
      const row = box(pane, 'bb-row');
      const save = mountButton(row, {
        label: 'Сохранить',
        size: 'sm',
        onClick: async () => {
          if (!draft.title.trim()) {
            title.update({ error: 'Заголовок не может быть пустым' });
            return;
          }
          save.update({ loading: true, disabled: true });
          try {
            await api.updatePullRequest(repo, pr, { title: draft.title.trim(), description: draft.description });
            await say(host, 'success', `PR #${pr.id} обновлён`);
            reload();
          } catch (error) {
            save.update({ loading: false, disabled: false });
            clear(errorRoot);
            mountBanner(errorRoot, { tone: 'error', title: 'Не сохранилось', body: describeError(error, { write: true }) });
          }
        },
      });
      mountButton(row, { label: 'Отмена', size: 'sm', variant: 'ghost', onClick: () => drawAbout(pane, repo, pr, reload) });
    },
  });
};

const drawDiff = async (pane: HTMLElement, repo: Repo, pr: PullRequest) => {
  mountSpinner(pane, { size: 'sm', label: 'Загружаю дифф…' });
  try {
    const diff = await api.diff(repo, pr);
    clear(pane);
    if (!diff.trim()) {
      pane.append(el('div', 'bb-muted', 'Дифф пуст.'));
      return;
    }
    renderDiff(pane, diff);
  } catch (error) {
    clear(pane);
    mountBanner(pane, { tone: 'error', title: 'Дифф не загрузился', body: describeError(error) });
  }
};

const drawComments = async (pane: HTMLElement, repo: Repo, pr: PullRequest, reload: () => void) => {
  mountSpinner(pane, { size: 'sm', label: 'Загружаю комментарии…' });
  let comments: Comment[];
  try {
    comments = await api.comments(repo, pr.id);
  } catch (error) {
    clear(pane);
    mountBanner(pane, { tone: 'error', title: 'Комментарии не загрузились', body: describeError(error) });
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
      node.append(el('div', 'bb-small bb-muted', `${comment.user.display_name} · ${relativeTime(comment.created_on)}`));
      mountText(box(node), { text: comment.content.raw, onOpenUrl: openUrl });
      draw(comment.id, depth + 1);
    }
  };
  if (comments.length === 0) pane.append(el('div', 'bb-muted', 'Общих комментариев пока нет. Комментарии к строкам смотрите в Bitbucket.'));
  else draw(null, 0);

  let text = '';
  const field = mountTextField(box(pane), {
    label: 'Новый комментарий',
    value: '',
    multiline: true,
    rows: 3,
    placeholder: 'Markdown',
    onChange: (value) => { text = value; field.update({ value }); },
  });
  const send = mountButton(box(pane, 'bb-row'), {
    label: 'Отправить',
    size: 'sm',
    onClick: async () => {
      if (!text.trim()) return;
      send.update({ loading: true, disabled: true });
      try {
        await api.comment(repo, pr.id, text.trim());
        await say(host, 'success', 'Комментарий отправлен');
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
    if (participant?.approved) return { label: 'approve', tone: 'success' as const };
    if (participant?.state === 'changes_requested') return { label: 'правки', tone: 'warning' as const };
    return null;
  };
  const listRoot = box(pane, 'bb-stack');
  const addRoot = box(pane);
  const saveRoot = box(pane, 'bb-row');
  let members: User[] = [];

  const drawChosen = () => {
    clear(listRoot);
    if (chosen.size === 0) listRoot.append(el('div', 'bb-muted', 'Ревьюеров нет.'));
    for (const [uuid, name] of chosen) {
      const row = box(listRoot, 'bb-row');
      row.append(el('div', 'bb-grow', name));
      const state = stateOf(uuid);
      if (state) mountBadge(row, state);
      if (pr.state === 'OPEN') mountButton(row, { label: 'Убрать', size: 'xs', variant: 'ghost', onClick: () => { chosen.delete(uuid); drawChosen(); drawAdd(); } });
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
      placeholder: 'Добавить ревьюера',
      searchable: true,
      searchPlaceholder: 'Имя',
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
    label: 'Сохранить ревьюеров',
    size: 'sm',
    onClick: async () => {
      save.update({ loading: true, disabled: true });
      try {
        await api.updatePullRequest(repo, pr, { reviewers: [...chosen.keys()] });
        await say(host, 'success', 'Ревьюеры обновлены');
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
    mountBanner(addRoot, { tone: 'warning', title: 'Список участников workspace недоступен', body: describeError(error) });
  }
};

/* ---------- create ---------- */

function showCreate() {
  if (!current) return;
  generation++;
  const choice = current;
  clear(root);
  const top = box(root, 'bb-row');
  mountButton(top, { label: '← К списку', size: 'sm', variant: 'ghost', onClick: () => void showList() });
  root.append(el('div', 'bb-h', `Новый PR в ${repoKey(choice.repo)}`));
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
      title: 'Bitbucket не подключён',
      body: 'Откройте Settings → Integrations → Bitbucket и введите email Atlassian и API-токен со скоупами Bitbucket: account, repositories, pull requests, pipelines.',
    });
    return;
  }
  mountSpinner(root, { size: 'sm', label: 'Ищу репозитории…' });
  const [detection, manual, saved] = await Promise.all([
    directory ? detectRepos(host).catch(() => ({ repos: [], note: null })) : Promise.resolve({ repos: [] as LocalRepo[], note: null }),
    host.storage.get(MANUAL_KEY).catch(() => undefined),
    directory ? host.storage.get(pickKey(directory)).catch(() => undefined) : Promise.resolve(undefined),
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
  await showList();
};

const onContext = (context: HostReadyContext) => {
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
