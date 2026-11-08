# Bitbucket for OpenChamber

Bitbucket Cloud pull requests inside [OpenChamber](https://openchamber.dev), next to your sessions. See the PR of the branch you are on, review it, merge it, or hand it to the agent without leaving the chat.

## What you get

**Work Status section "Bitbucket PR"**: the pull request of the branch checked out in the open project.

- Title, Pipelines result, approvals, requested changes, target branch.
- Actions that fit your role: **Merge** (with the repository's merge strategies) and **Агенту** (hand to the agent) on your own PR, **Approve** and **Request changes** on someone else's. Draft/ready and decline sit under **Ещё** (more).
- No PR for the branch yet: **Создать PR** (create PR) right there.

**Rail panel "Bitbucket"**: the open pull requests of a repository.

- Tabs: **Мои** (mine), **Жду ревью** (awaiting my review), **Все открытые** (all open), plus search by title.
- A pull request in detail: description (editable), diff, general comments with a reply box, reviewers (add and remove from the workspace members).
- A **Новый PR** (new PR) form with the repository's default reviewers.

**Hand a PR to the agent**: puts a pull-request chip on the chat composer with the PR's title, branches, description and diff. A long diff is cut to fit, and the chip says so.

## Repositories it finds

The extension reads the open project's git files: the project itself and its **submodules** (`.git/modules/*`), so a superproject whose pull requests live in submodules works too. When the project has several Bitbucket repositories, it starts with the one on a feature branch and remembers your choice per project. A repository that isn't in the project can be opened by hand as `workspace/repo`.

## Setup

1. Install from Settings → Extensions with this repository's URL, and approve what it asks for:
   - **files**: read access to the project's `.git` folder, to find the repositories and the current branch. The extension never writes files.
   - **network**: only `https://api.bitbucket.org`.
2. Create an Atlassian API token with Bitbucket scopes at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Tested with: `read:user`, `read:workspace`, `read:repository`, `write:repository`, `read:pullrequest`, `write:pullrequest`, `read:pipeline` (all `:bitbucket`).
3. Settings → Integrations → **Bitbucket**: enter your Atlassian email and the token. OpenChamber stores the token and adds it to each request; the extension's pages never see it.

## Behaviour worth knowing

- **Quiet by design.** Nothing polls. The section reads Bitbucket when it appears, when you switch project, and on **Обновить** (refresh). After switching branches, press it.
- **Merge and Decline ask twice.** Merge asks you to pick a strategy; Decline asks you to confirm, because Bitbucket Cloud can't reopen a declined PR.
- **Merge runs asynchronously** (`async=true`). When Bitbucket runs it as a task, you are told to refresh in a few seconds.
- **The UI is in Russian** for now; this README gives each button name with a translation.

## Limits

- Bitbucket **Cloud** only (not Data Center / Server).
- A linked git worktree keeps its git data outside the project folder, so the section can't read it. Pick the repository in the panel instead.
- Inline (line) comments are not shown; open the PR in Bitbucket for those.
- This is not a native OpenChamber Git host: no board, no branch badges, no worktree from a PR, no Changes tab. OpenChamber 2.7 binds a Git host's API to the same origin as the git remote, and Bitbucket serves its token-authenticated API only on `api.bitbucket.org`, not on `bitbucket.org`.

## Development

```sh
bun install
bun run build   # bundles status/main.ts and panel/main.ts into the .js files OpenChamber loads
bun run check   # tsc + openchamber-guest-check
```

The built `status/main.js` and `panel/main.js` are committed on purpose: OpenChamber installs from git without building.
