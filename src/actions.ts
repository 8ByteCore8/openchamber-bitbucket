import type { HostClient } from '@openchamber/sdk';
import { mountBanner, mountButton } from '@openchamber/sdk/ui';
import {
  MERGE_STRATEGY_LABELS,
  describeError,
  myReview,
  pullRequestChip,
  say,
  type Api,
  type MergeStrategy,
  type PullRequest,
  type Repo,
} from './api.ts';
import { box, clear, el } from './dom.ts';

// The actions of one PR, shared by the Work Status section and the panel.
// No popups: a Work Status frame is a few lines high and would clip them, so
// choices open in place under the row. Merge and Decline cannot be undone,
// so each needs a second, explicit click. In compact mode (Work Status) only
// the one or two actions that fit the user's role stay on the row; the rest
// sit behind "Ещё".

export type PrActionsContext = {
  host: HostClient;
  api: Api;
  repo: Repo;
  pr: PullRequest;
  meUuid: string;
  /** Called after a change on Bitbucket, to read the PR again. */
  onChanged: () => void;
  compact?: boolean;
  /** Extra entries for the "Ещё" row, such as "Обновить" where the host has no header buttons. */
  extra?: { label: string; run: () => void }[];
};

type Action = { label: string; variant: 'default' | 'outline' | 'ghost'; run: () => void; primary?: boolean };

export const handOff = async (host: HostClient, api: Api, repo: Repo, pr: PullRequest) => {
  try {
    const diff = await api.diff(repo, pr);
    await host.attach(pullRequestChip(repo, pr, diff));
    await say(host, 'success', `PR #${pr.id} добавлен в поле ввода чата`);
  } catch (error) {
    await say(host, 'error', `Не удалось передать PR: ${describeError(error)}`);
  }
};

export const mountPrActions = (parent: HTMLElement, context: PrActionsContext) => {
  const { host, api, repo, pr, meUuid, onChanged } = context;
  const root = box(parent, 'bb-stack');
  root.style.gap = '6px';
  const row = box(root, 'bb-row');
  const more = box(root, 'bb-row');
  more.hidden = true;
  const drawer = box(root, 'bb-stack');
  const isAuthor = pr.author.uuid === meUuid;
  const review = myReview(pr, meUuid);
  const open = pr.state === 'OPEN';

  /** Runs a change; `work` may return its own message instead of `done`. */
  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      const message = await work();
      await say(host, 'success', typeof message === 'string' ? message : done);
      onChanged();
    } catch (error) {
      await say(host, 'error', describeError(error, { write: true }));
    }
  };

  const cancelButton = (parentRow: HTMLElement) =>
    mountButton(parentRow, { label: 'Отмена', variant: 'ghost', size: 'xs', onClick: () => clear(drawer) });

  const showMerge = async () => {
    clear(drawer);
    drawer.append(el('div', 'bb-muted bb-small', 'Загружаю стратегии merge…'));
    try {
      const { strategies, fallback } = await api.mergeStrategies(repo, pr.destination.branch.name);
      clear(drawer);
      const branchNote = pr.close_source_branch ? ` Ветка ${pr.source.branch.name} будет удалена.` : '';
      drawer.append(el('div', 'bb-small', `Merge в ${pr.destination.branch.name}, стратегия:${branchNote}`));
      const choices = box(drawer, 'bb-row');
      const ordered = [fallback, ...strategies.filter((strategy) => strategy !== fallback)].filter((strategy) => strategies.includes(strategy));
      for (const strategy of ordered) {
        mountButton(choices, {
          label: MERGE_STRATEGY_LABELS[strategy as MergeStrategy] ?? strategy,
          variant: strategy === fallback ? 'default' : 'outline',
          size: 'xs',
          onClick: () => {
            clear(drawer);
            void run(async () => {
              const { queued } = await api.merge(repo, pr.id, strategy, pr.close_source_branch);
              return queued ? `Bitbucket начал merge PR #${pr.id}. Через несколько секунд нажмите «Обновить».` : undefined;
            }, `PR #${pr.id} смержен`);
          },
        });
      }
      cancelButton(choices);
    } catch (error) {
      clear(drawer);
      mountBanner(drawer, { tone: 'error', title: 'Не удалось прочитать стратегии merge', body: describeError(error) });
    }
  };

  const showDecline = () => {
    clear(drawer);
    mountBanner(drawer, {
      tone: 'warning',
      title: `Отклонить PR #${pr.id}?`,
      body: 'В Bitbucket Cloud отклонённый PR нельзя открыть снова.',
      action: { label: 'Отклонить', onClick: () => { clear(drawer); void run(() => api.decline(repo, pr.id), `PR #${pr.id} отклонён`); } },
    });
    cancelButton(box(drawer, 'bb-row'));
  };

  const actions: Action[] = [];
  if (open && !isAuthor) {
    actions.push({
      label: review.approved ? 'Снять Approve' : 'Approve',
      variant: review.approved ? 'outline' : 'default',
      primary: true,
      run: () => void run(() => api.approve(repo, pr.id, !review.approved), review.approved ? 'Approve снят' : `PR #${pr.id} одобрен`),
    });
    actions.push({
      label: review.changesRequested ? 'Снять Request changes' : 'Request changes',
      variant: 'outline',
      primary: true,
      run: () => void run(
        () => api.requestChanges(repo, pr.id, !review.changesRequested),
        review.changesRequested ? 'Запрос изменений снят' : 'Изменения запрошены',
      ),
    });
  }
  if (open && !pr.draft) actions.push({ label: 'Merge', variant: isAuthor ? 'default' : 'outline', primary: isAuthor, run: () => void showMerge() });
  if (open && isAuthor) {
    actions.push({
      label: pr.draft ? 'Готов к ревью' : 'В черновик',
      variant: pr.draft ? 'default' : 'outline',
      primary: pr.draft,
      run: () => void run(
        () => api.updatePullRequest(repo, pr, { draft: !pr.draft }),
        pr.draft ? `PR #${pr.id} больше не черновик` : `PR #${pr.id} снова черновик`,
      ),
    });
  }
  actions.push({ label: 'Агенту', variant: 'outline', primary: isAuthor || !open, run: () => void handOff(host, api, repo, pr) });
  if (!context.compact) actions.push({ label: 'В Bitbucket', variant: 'ghost', run: () => void host.openUrl(pr.links.html.href) });
  if (open) actions.push({ label: 'Отклонить', variant: 'ghost', run: showDecline });

  const place = (target: HTMLElement, action: Action) =>
    mountButton(target, { label: action.label, variant: action.variant, size: 'xs', onClick: action.run });

  if (!context.compact) {
    for (const action of actions) place(row, action);
    return root;
  }
  for (const action of actions.filter((entry) => entry.primary)) place(row, action);
  for (const action of actions.filter((entry) => !entry.primary)) place(more, { ...action, variant: 'ghost' });
  for (const entry of context.extra ?? []) mountButton(more, { label: entry.label, variant: 'ghost', size: 'xs', onClick: entry.run });
  if (more.childElementCount > 0) {
    const toggle = mountButton(row, {
      label: 'Ещё',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        more.hidden = !more.hidden;
        toggle.update({ label: more.hidden ? 'Ещё' : 'Скрыть' });
      },
    });
  }
  return root;
};
