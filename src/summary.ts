import type { HostClient } from '@openchamber/sdk';
import { mountBadge } from '@openchamber/sdk/ui';
import { pipelineStateLabel, pipelineSummary, reviewSummary, type CommitStatus, type PullRequest, type Repo } from './api.ts';
import { box, el } from './dom.ts';
import { isolate, relativeTime, t } from './i18n/index.ts';

const STATE_KEYS = { OPEN: 'stateOpen', MERGED: 'stateMerged', DECLINED: 'stateDeclined', SUPERSEDED: 'stateSuperseded' } as const;

/** Title, state, Pipelines and review badges, branches and author of one PR. */
export const renderPrSummary = (parent: HTMLElement, host: HostClient, pr: PullRequest, statuses: CommitStatus[] | null) => {
  const root = box(parent, 'bb-stack');
  root.style.gap = '4px';
  const title = root.appendChild(el('div', 'bb-title', `#${pr.id} ${pr.title}`));
  title.title = t('openInBitbucket');
  title.addEventListener('click', () => void host.openUrl(pr.links.html.href));

  const chips = box(root, 'bb-chips');
  if (pr.state !== 'OPEN') mountBadge(chips, { label: t(STATE_KEYS[pr.state]), tone: pr.state === 'MERGED' ? 'success' : 'neutral' });
  else if (pr.draft) mountBadge(chips, { label: t('draft'), tone: 'neutral' });
  const pipeline = statuses ? pipelineSummary(statuses) : null;
  if (pipeline) {
    const holder = box(chips);
    holder.style.cursor = pipeline.url ? 'pointer' : 'default';
    if (pipeline.url) holder.addEventListener('click', () => void host.openUrl(pipeline.url!));
    mountBadge(holder, { label: t('pipeline', { state: pipelineStateLabel(pipeline.state) }), tone: pipeline.tone });
  }
  const { approvals, changes } = reviewSummary(pr);
  if (approvals.length > 0) {
    const holder = box(chips);
    holder.title = t('approvedBy', { names: approvals.join(', ') });
    mountBadge(holder, { label: t('approvals', { count: approvals.length }), tone: 'success' });
  }
  if (changes.length > 0) {
    const holder = box(chips);
    holder.title = t('changesBy', { names: changes.join(', ') });
    mountBadge(holder, { label: t('needsChanges', { count: changes.length }), tone: 'warning' });
  }
  if (pr.comment_count > 0) mountBadge(chips, { label: t('comments', { count: pr.comment_count }) });

  root.append(el(
    'div',
    'bb-small bb-muted',
    `${isolate(`${pr.source.branch.name} → ${pr.destination.branch.name}`)} · ${t('authorTime', { author: pr.author.display_name, time: relativeTime(pr.updated_on) })}`,
  ));
  return root;
};

export const TONE_COLOR = { success: 'var(--oc-success-text)', error: 'var(--oc-error-text)', warning: 'var(--oc-warning-text)', info: 'var(--oc-info-text)' };

/**
 * Two lines for Work Status: the title cut to one line (full text on hover),
 * then a status line. The source branch is the checked-out one, so it is left out.
 */
export const renderPrCompact = (parent: HTMLElement, host: HostClient, repo: Repo, pr: PullRequest, statuses: CommitStatus[] | null, meUuid: string) => {
  const root = box(parent, 'bb-stack');
  root.style.gap = '2px';
  const title = root.appendChild(el('div', 'bb-title bb-ellipsis', `#${pr.id} ${pr.title}`));
  title.title = `${pr.title}\n${t('openInBitbucket')}`;
  title.addEventListener('click', () => void host.openUrl(pr.links.html.href));

  const line = box(root, 'bb-meta bb-small bb-muted');
  const part = (text: string, color?: string, hint?: string) => {
    const span = line.appendChild(el('span', undefined, text));
    if (color) span.style.color = color;
    if (hint) span.title = hint;
    return span;
  };
  if (pr.draft) part(t('listDraft'));
  const pipeline = statuses ? pipelineSummary(statuses) : null;
  if (pipeline) {
    const span = part(`● ${pipelineStateLabel(pipeline.state)}`, TONE_COLOR[pipeline.tone], t('pipeline', { state: pipelineStateLabel(pipeline.state) }));
    if (pipeline.url) {
      span.classList.add('bb-link');
      span.addEventListener('click', () => void host.openUrl(pipeline.url!));
    }
  }
  const { approvals, changes } = reviewSummary(pr);
  if (approvals.length > 0) part(`✓ ${approvals.length}`, TONE_COLOR.success, t('approvedBy', { names: approvals.join(', ') }));
  if (changes.length > 0) part(t('needsChanges', { count: changes.length }), TONE_COLOR.warning, t('changesBy', { names: changes.join(', ') }));
  if (pr.comment_count > 0) part(t('comments', { count: pr.comment_count }));
  part(isolate(`${repo.slug} → ${pr.destination.branch.name}`));
  const time = relativeTime(pr.updated_on);
  part(pr.author.uuid === meUuid ? time : t('authorTime', { author: pr.author.display_name, time }));
  return root;
};
