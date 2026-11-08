import type { HostClient } from '@openchamber/sdk';
import { mountBanner, mountButton } from '@openchamber/sdk/ui';
import {
  describeError,
  myReview,
  pullRequestChip,
  say,
  strategyLabel,
  type Api,
  type PullRequest,
  type Repo,
} from './api.ts';
import { box, clear, el } from './dom.ts';
import { isolate, t } from './i18n/index.ts';

// The actions of one PR, shared by the Work Status section and the panel.
// No popups: a Work Status frame is a few lines high and would clip them, so
// choices open in place under the row. Merge and Decline cannot be undone,
// so each needs a second, explicit click. In compact mode (Work Status) only
// the one or two actions that fit the user's role stay on the row; the rest
// sit behind "More".

export type PrActionsContext = {
  host: HostClient;
  api: Api;
  repo: Repo;
  pr: PullRequest;
  meUuid: string;
  /** Called after a change on Bitbucket, to read the PR again. */
  onChanged: () => void;
  compact?: boolean;
  /** Extra entries for the "More" row, such as "Refresh" where the host has no header buttons. */
  extra?: { label: string; run: () => void }[];
};

type Action = { label: string; variant: 'default' | 'outline' | 'ghost'; run: () => void; primary?: boolean };

export const handOff = async (host: HostClient, api: Api, repo: Repo, pr: PullRequest) => {
  try {
    const diff = await api.diff(repo, pr);
    await host.attach(pullRequestChip(repo, pr, diff));
    await say(host, 'success', t('handedOff', { id: pr.id }));
  } catch (error) {
    await say(host, 'error', t('handOffFailed', { error: describeError(error) }));
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
    mountButton(parentRow, { label: t('cancel'), variant: 'ghost', size: 'xs', onClick: () => clear(drawer) });

  const showMerge = async () => {
    clear(drawer);
    drawer.append(el('div', 'bb-muted bb-small', t('loadingStrategies')));
    try {
      const { strategies, fallback } = await api.mergeStrategies(repo, pr.destination.branch.name);
      clear(drawer);
      const intro = [t('mergeInto', { branch: isolate(pr.destination.branch.name) })];
      if (pr.close_source_branch) intro.push(t('branchWillBeDeleted', { branch: isolate(pr.source.branch.name) }));
      drawer.append(el('div', 'bb-small', intro.join(' ')));
      const choices = box(drawer, 'bb-row');
      const ordered = [fallback, ...strategies.filter((strategy) => strategy !== fallback)].filter((strategy) => strategies.includes(strategy));
      for (const strategy of ordered) {
        mountButton(choices, {
          label: strategyLabel(strategy),
          variant: strategy === fallback ? 'default' : 'outline',
          size: 'xs',
          onClick: () => {
            clear(drawer);
            void run(async () => {
              const { queued } = await api.merge(repo, pr.id, strategy, pr.close_source_branch);
              return queued ? t('mergeStarted', { id: pr.id }) : undefined;
            }, t('merged', { id: pr.id }));
          },
        });
      }
      cancelButton(choices);
    } catch (error) {
      clear(drawer);
      mountBanner(drawer, { tone: 'error', title: t('strategiesFailed'), body: describeError(error) });
    }
  };

  const showDecline = () => {
    clear(drawer);
    mountBanner(drawer, {
      tone: 'warning',
      title: t('declineTitle', { id: pr.id }),
      body: t('declineBody'),
      action: { label: t('decline'), onClick: () => { clear(drawer); void run(() => api.decline(repo, pr.id), t('declined', { id: pr.id })); } },
    });
    cancelButton(box(drawer, 'bb-row'));
  };

  const actions: Action[] = [];
  if (open && !isAuthor) {
    actions.push({
      label: review.approved ? t('unapprove') : t('approve'),
      variant: review.approved ? 'outline' : 'default',
      primary: true,
      run: () => void run(() => api.approve(repo, pr.id, !review.approved), review.approved ? t('unapproved') : t('approved', { id: pr.id })),
    });
    actions.push({
      label: review.changesRequested ? t('unrequestChanges') : t('requestChanges'),
      variant: 'outline',
      primary: true,
      run: () => void run(
        () => api.requestChanges(repo, pr.id, !review.changesRequested),
        review.changesRequested ? t('changesUnrequested') : t('changesRequested'),
      ),
    });
  }
  if (open && !pr.draft) actions.push({ label: t('merge'), variant: isAuthor ? 'default' : 'outline', primary: isAuthor, run: () => void showMerge() });
  if (open && isAuthor) {
    actions.push({
      label: pr.draft ? t('readyForReview') : t('toDraft'),
      variant: pr.draft ? 'default' : 'outline',
      primary: pr.draft,
      run: () => void run(
        () => api.updatePullRequest(repo, pr, { draft: !pr.draft }),
        pr.draft ? t('isReady', { id: pr.id }) : t('isDraft', { id: pr.id }),
      ),
    });
  }
  actions.push({ label: t('toAgent'), variant: 'outline', primary: isAuthor || !open, run: () => void handOff(host, api, repo, pr) });
  if (!context.compact) actions.push({ label: t('openInBitbucket'), variant: 'ghost', run: () => void host.openUrl(pr.links.html.href) });
  if (open) actions.push({ label: t('decline'), variant: 'ghost', run: showDecline });

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
      label: t('more'),
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        more.hidden = !more.hidden;
        toggle.update({ label: more.hidden ? t('more') : t('less') });
      },
    });
  }
  return root;
};
