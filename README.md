# Bitbucket for OpenChamber

Bitbucket Cloud pull requests inside [OpenChamber](https://openchamber.dev), next to your sessions. See the PR of the branch you are on, review it, merge it, or hand it to the agent without leaving the chat.

## What you get

**Work Status section "Bitbucket PR"**: the pull request of the branch checked out in the open project.

- Title, Pipelines result, approvals, requested changes, target branch.
- Actions that fit your role: **Merge** (with the repository's merge strategies) and **To agent** on your own PR, **Approve** and **Request changes** on someone else's. Draft/ready and **Decline** sit under **More**.
- No PR for the branch yet: **Create PR** right there.
- **Whole project** (in the section's repository picker, for a project with submodules): one line per repository that is on a feature branch, with its Pipelines dot and its branch's PR, or "no PR". Repositories on the main branch are only counted. A click opens that PR in the section with the usual buttons; **←** goes back to the list.

**Rail panel "Bitbucket"**: open pull requests, for one repository or many at once.

- **Whole project**: every Bitbucket repository of the open project, submodules included, in one list. Each row names its repository.
- **All my PRs**: the pull requests you authored in all your workspaces, including repositories outside the project.
- One repository at a time, as before.
- Tabs: **Mine**, **Awaiting my review**, **All open**, plus search (by title; in the combined lists also by repository). **All my PRs** has no tabs: Bitbucket can list your own PRs across a workspace, but not the ones waiting for your review.
- A pull request in detail: description (editable), diff, general comments with a reply box, reviewers (add and remove from the workspace members).
- A **New PR** form with the repository's default reviewers.

**Hand a PR to the agent**: puts a pull-request chip on the chat composer with the PR's title, branches, description and diff. A long diff is cut to fit, and the chip says so.

## Repositories it finds

The extension reads the open project's git files: the project itself and its **submodules** (`.git/modules/*`), so a superproject whose pull requests live in submodules works too. When the project has several Bitbucket repositories, the panel opens on **Whole project** and the Work Status section on the repository with a feature branch; both remember your choice per project. **Whole project** asks Bitbucket once per repository, side by side; a repository that does not answer is named under the list, the others still show. A repository that isn't in the project can be opened by hand as `workspace/repo`.

## Setup

1. Install from Settings → Extensions with this repository's URL, and approve what it asks for:
   - **files**: read access to the project's `.git` folder, to find the repositories and the current branch. The extension never writes files.
   - **network**: only `https://api.bitbucket.org`.
2. Create an Atlassian API token with Bitbucket scopes at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Tested with: `read:user`, `read:workspace`, `read:repository`, `write:repository`, `read:pullrequest`, `write:pullrequest`, `read:pipeline` (all `:bitbucket`).
3. Settings → Integrations → **Bitbucket**: enter your Atlassian email and the token. OpenChamber stores the token and adds it to each request; the extension's pages never see it.

## Behaviour worth knowing

- **Quiet by design.** Nothing polls. The section reads Bitbucket when it appears, when you switch project, and on **Refresh**. After switching branches, press **Refresh**.
- **Merge and Decline ask twice.** Merge asks you to pick a strategy; Decline asks you to confirm, because Bitbucket Cloud can't reopen a declined PR.
- **Merge runs asynchronously** (`async=true`). When Bitbucket runs it as a task, you are told to refresh in a few seconds.

## Languages

The interface follows OpenChamber's language: English, German, French, Dutch, Simplified and Traditional Chinese, Ukrainian, Spanish, Brazilian Portuguese, Korean, Polish, Japanese, Turkish, Arabic and Hebrew (right to left), plus Russian. Dates use the language's own format.

English is the original. The other translations were not written by native speakers, so corrections are welcome: each language is one file in `src/i18n/`, and `bun run check` verifies that every file has every key with the same `{placeholders}`. Menu paths such as Settings → Integrations stay in English in every language.

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

The built `status/main.js` and `panel/main.js` are committed on purpose: OpenChamber installs from git without building. The **Check** workflow fails when they differ from a fresh build.

## Releasing

1. Raise `version` in `package.json` (OpenChamber offers an update only when it grows), run `bun run build`, commit.
2. Tag and push: `git tag -a v0.2.0 -m v0.2.0 && git push origin main v0.2.0`.

The **Release** workflow checks that the tag equals the version, builds, runs the checks, and publishes a GitHub release with notes and an installable zip. Users can pin a release with `#v0.2.0` on the install URL.
