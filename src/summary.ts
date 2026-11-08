import type { HostClient } from '@openchamber/sdk';
import { mountBadge } from '@openchamber/sdk/ui';
import { pipelineSummary, reviewSummary, type CommitStatus, type PullRequest, type Repo } from './api.ts';
import { box, el, relativeTime } from './dom.ts';

/** Title, state, Pipelines and review badges, branches and author of one PR. */
export const renderPrSummary = (parent: HTMLElement, host: HostClient, pr: PullRequest, statuses: CommitStatus[] | null) => {
  const root = box(parent, 'bb-stack');
  root.style.gap = '4px';
  const title = root.appendChild(el('div', 'bb-title', `#${pr.id} ${pr.title}`));
  title.title = 'Открыть в Bitbucket';
  title.addEventListener('click', () => void host.openUrl(pr.links.html.href));

  const chips = box(root, 'bb-chips');
  if (pr.state !== 'OPEN') mountBadge(chips, { label: pr.state, tone: pr.state === 'MERGED' ? 'success' : 'neutral' });
  else if (pr.draft) mountBadge(chips, { label: 'Черновик', tone: 'neutral' });
  const pipeline = statuses ? pipelineSummary(statuses) : null;
  if (pipeline) {
    const holder = box(chips);
    holder.style.cursor = pipeline.url ? 'pointer' : 'default';
    if (pipeline.url) holder.addEventListener('click', () => void host.openUrl(pipeline.url!));
    mountBadge(holder, { label: pipeline.label, tone: pipeline.tone });
  }
  const { approvals, changes } = reviewSummary(pr);
  if (approvals.length > 0) {
    const holder = box(chips);
    holder.title = approvals.join(', ');
    mountBadge(holder, { label: `Approve: ${approvals.length}`, tone: 'success' });
  }
  if (changes.length > 0) {
    const holder = box(chips);
    holder.title = changes.join(', ');
    mountBadge(holder, { label: `Нужны правки: ${changes.length}`, tone: 'warning' });
  }
  if (pr.comment_count > 0) mountBadge(chips, { label: `Комментарии: ${pr.comment_count}` });

  root.append(el(
    'div',
    'bb-small bb-muted',
    `${pr.source.branch.name} → ${pr.destination.branch.name} · ${pr.author.display_name} · ${relativeTime(pr.updated_on)}`,
  ));
  return root;
};

const TONE_COLOR = { success: 'var(--oc-success-text)', error: 'var(--oc-error-text)', warning: 'var(--oc-warning-text)', info: 'var(--oc-info-text)' };

/**
 * Two lines for Work Status: the title cut to one line (full text on hover),
 * then a status line. The source branch is the checked-out one, so it is left out.
 */
export const renderPrCompact = (parent: HTMLElement, host: HostClient, repo: Repo, pr: PullRequest, statuses: CommitStatus[] | null, meUuid: string) => {
  const root = box(parent, 'bb-stack');
  root.style.gap = '2px';
  const title = root.appendChild(el('div', 'bb-title bb-ellipsis', `#${pr.id} ${pr.title}`));
  title.title = `${pr.title}\nОткрыть в Bitbucket`;
  title.addEventListener('click', () => void host.openUrl(pr.links.html.href));

  const line = box(root, 'bb-meta bb-small bb-muted');
  const part = (text: string, color?: string, hint?: string) => {
    const span = line.appendChild(el('span', undefined, text));
    if (color) span.style.color = color;
    if (hint) span.title = hint;
    return span;
  };
  if (pr.draft) part('черновик');
  const pipeline = statuses ? pipelineSummary(statuses) : null;
  if (pipeline) {
    const span = part(`● ${pipeline.label.replace('Pipeline: ', '')}`, TONE_COLOR[pipeline.tone], 'Pipeline');
    if (pipeline.url) {
      span.classList.add('bb-link');
      span.addEventListener('click', () => void host.openUrl(pipeline.url!));
    }
  }
  const { approvals, changes } = reviewSummary(pr);
  if (approvals.length > 0) part(`✓ ${approvals.length}`, TONE_COLOR.success, `Approve: ${approvals.join(', ')}`);
  if (changes.length > 0) part(`правки ${changes.length}`, TONE_COLOR.warning, `Запросили правки: ${changes.join(', ')}`);
  if (pr.comment_count > 0) part(`комм. ${pr.comment_count}`);
  part(`${repo.slug} → ${pr.destination.branch.name}`);
  part(pr.author.uuid === meUuid ? relativeTime(pr.updated_on) : `${pr.author.display_name}, ${relativeTime(pr.updated_on)}`);
  return root;
};
