import type { HostClient } from '@openchamber/sdk';
import { mountBanner, mountButton, mountCheckbox, mountTextField } from '@openchamber/sdk/ui';
import { describeError, say, type Api, type PullRequest, type Repo } from './api.ts';
import { box, clear, el } from './dom.ts';
import { t } from './i18n/index.ts';

// The "new pull request" form, used in Work Status (for the checked-out
// branch) and in the panel (for any branch). Fields only, no popups.

export type CreateFormOptions = {
  host: HostClient;
  api: Api;
  repo: Repo;
  /** Source branch; null lets the user type it. */
  source: string | null;
  onCreated: (pr: PullRequest) => void;
  onCancel: () => void;
};

const titleFromBranch = (branch: string) => {
  const name = branch.split('/').pop() ?? branch;
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : branch;
};

export const mountCreateForm = (parent: HTMLElement, options: CreateFormOptions) => {
  const { host, api, repo, onCreated, onCancel } = options;
  const root = box(parent, 'bb-stack');
  const state = {
    source: options.source ?? '',
    destination: '',
    title: options.source ? titleFromBranch(options.source) : '',
    description: '',
    draft: false,
    closeSource: true,
    defaults: true,
  };
  let defaultReviewers: { uuid: string; display_name: string }[] = [];

  if (options.source === null) {
    const field = mountTextField(box(root), {
      label: t('fromBranch'),
      value: state.source,
      mono: true,
      placeholder: 'feature/my-change',
      onChange: (value) => { state.source = value; field.update({ value }); },
    });
  } else {
    root.append(el('div', 'bb-small bb-muted', t('fromBranchValue', { branch: options.source })));
  }
  const destination = mountTextField(box(root), {
    label: t('toBranch'),
    value: '',
    mono: true,
    placeholder: t('loadingMainBranch'),
    onChange: (value) => { state.destination = value; destination.update({ value }); },
  });
  const title = mountTextField(box(root), {
    label: t('title'),
    value: state.title,
    onChange: (value) => { state.title = value; title.update({ value }); },
  });
  const description = mountTextField(box(root), {
    label: t('description'),
    value: '',
    multiline: true,
    rows: 4,
    placeholder: t('markdown'),
    onChange: (value) => { state.description = value; description.update({ value }); },
  });
  const flags = box(root, 'bb-row');
  const draft = mountCheckbox(flags, { label: t('draft'), checked: false, onChange: (checked) => { state.draft = checked; draft.update({ checked }); } });
  const closeSource = mountCheckbox(flags, {
    label: t('deleteBranchAfterMerge'),
    checked: true,
    onChange: (checked) => { state.closeSource = checked; closeSource.update({ checked }); },
  });
  const reviewersRoot = box(root);
  const errorRoot = box(root);
  const buttons = box(root, 'bb-row');

  const submit = mountButton(buttons, {
    label: t('createPr'),
    size: 'sm',
    onClick: async () => {
      clear(errorRoot);
      if (!state.source.trim() || !state.destination.trim() || !state.title.trim()) {
        mountBanner(errorRoot, { tone: 'warning', title: t('fillBranchesTitle') });
        return;
      }
      submit.update({ loading: true, disabled: true });
      try {
        const pr = await api.createPullRequest(repo, {
          title: state.title.trim(),
          description: state.description,
          source: state.source.trim(),
          destination: state.destination.trim(),
          reviewers: state.defaults ? defaultReviewers.map((user) => user.uuid) : [],
          draft: state.draft,
          closeSourceBranch: state.closeSource,
        });
        await say(host, 'success', t('created', { id: pr.id }));
        onCreated(pr);
      } catch (error) {
        submit.update({ loading: false, disabled: false });
        mountBanner(errorRoot, { tone: 'error', title: t('notCreated'), body: describeError(error, { write: true }) });
      }
    },
  });
  mountButton(buttons, { label: t('cancel'), variant: 'ghost', size: 'sm', onClick: onCancel });

  api.repository(repo).then(
    (info) => {
      if (!state.destination && info.mainbranch?.name) {
        state.destination = info.mainbranch.name;
        destination.update({ value: state.destination, placeholder: 'main' });
      } else destination.update({ placeholder: 'main' });
    },
    () => destination.update({ placeholder: 'main' }),
  );
  // Bitbucket refuses a PR that lists its author as a reviewer.
  Promise.all([api.defaultReviewers(repo), api.me()]).then(
    ([all, me]) => {
      const users = all.filter((user) => user.uuid !== me.uuid);
      defaultReviewers = users;
      if (users.length === 0) return;
      const box = mountCheckbox(reviewersRoot, {
        label: t('defaultReviewers', { names: users.map((user) => user.display_name).join(', ') }),
        checked: true,
        onChange: (checked) => { state.defaults = checked; box.update({ checked }); },
      });
    },
    () => {},
  );
  return root;
};
