// Small DOM helpers and the page's own styles. Controls come from the SDK kit;
// this only lays them out and draws text, diff and comment blocks in host colours.

import { t } from './i18n/index.ts';

const STYLE = `
:root { color-scheme: light dark; }
html, body { margin: 0; background: var(--oc-bg); color: var(--oc-fg); font-family: var(--oc-font); font-size: 13px; }
* { box-sizing: border-box; }
.bb-stack { display: flex; flex-direction: column; gap: 8px; }
.bb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bb-grow { flex: 1 1 auto; min-width: 0; }
.bb-muted { color: var(--oc-muted); }
.bb-small { font-size: 12px; }
.bb-title { font-weight: 600; cursor: pointer; overflow-wrap: anywhere; }
.bb-title:hover { text-decoration: underline; }
.bb-ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bb-meta { display: flex; flex-wrap: wrap; column-gap: 8px; row-gap: 0; }
.bb-h { font-weight: 600; margin: 4px 0 0; }
.bb-mono { font-family: var(--oc-mono); direction: ltr; unicode-bidi: isolate; }
.bb-card { background: var(--oc-muted-surface); border-radius: var(--oc-radius); padding: 8px 10px; }
.bb-pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.bb-diff { direction: ltr; text-align: left; font-family: var(--oc-mono); font-size: 12px; line-height: 1.45; background: var(--oc-muted-surface); border-radius: var(--oc-radius); overflow-x: auto; padding: 6px 0; }
.bb-diff div { white-space: pre; padding: 0 10px; min-height: 1.45em; }
.bb-diff .add { background: color-mix(in srgb, var(--oc-success) 16%, transparent); }
.bb-diff .del { background: color-mix(in srgb, var(--oc-error) 16%, transparent); }
.bb-diff .hunk { color: var(--oc-info-text); }
.bb-diff .file { font-weight: 600; color: var(--oc-fg); background: var(--oc-subtle); margin-top: 6px; padding-top: 2px; padding-bottom: 2px; }
.bb-comment { border-left: 2px solid var(--oc-border); padding: 2px 0 2px 10px; }
.bb-comment.reply { margin-left: 16px; }
.bb-link { color: var(--oc-primary-text); cursor: pointer; }
.bb-link:hover { text-decoration: underline; }
.bb-click { cursor: pointer; border-radius: 4px; padding: 1px 4px; margin: 0 -4px; }
.bb-click:hover { background: var(--oc-subtle); }
.bb-chips { display: flex; flex-wrap: wrap; gap: 4px; }
[hidden] { display: none !important; }
`;

export const installStyle = () => {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
};

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export const box = (parent: HTMLElement, className?: string) => parent.appendChild(el('div', className));

export const clear = (node: HTMLElement) => {
  node.replaceChildren();
  return node;
};

const DIFF_LINES_MAX = 4000;

/** Draws a unified diff, colouring files, hunks, additions and deletions. */
export const renderDiff = (parent: HTMLElement, diff: string) => {
  const node = box(parent, 'bb-diff');
  const lines = diff.split('\n');
  for (const line of lines.slice(0, DIFF_LINES_MAX)) {
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const row = el('div');
    if (line.startsWith('diff --git')) {
      row.className = 'file';
      row.textContent = line.replace(/^diff --git a\/(.+?) b\/.+$/, '$1');
    } else {
      if (line.startsWith('@@')) row.className = 'hunk';
      else if (line.startsWith('+')) row.className = 'add';
      else if (line.startsWith('-')) row.className = 'del';
      row.textContent = line;
    }
    node.append(row);
  }
  if (lines.length > DIFF_LINES_MAX) {
    node.append(el('div', 'hunk', `… ${t('diffMore', { count: lines.length - DIFF_LINES_MAX })}`));
  }
  return node;
};
