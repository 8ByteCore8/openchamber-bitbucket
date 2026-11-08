# Feature request for openchamber/openchamber (not published)

Template: `.github/ISSUE_TEMPLATE/feature_request.yml`. CONTRIBUTING asks for a few sentences in your own words; a pull request opened before the maintainer marks the request `accepted` is closed automatically.

Searched on 2026-11-08: no issue about Bitbucket or a separate API origin. Closest, different: #6558 (extension-owned sign-in for CLI-backed providers, accepted).

**Title:** [Feature] Extension Git hosts: an API origin separate from the Git host (Bitbucket Cloud)

**What are you trying to do, and what gets in the way?**

I'm building a Bitbucket Cloud Git host as an extension (`provides: ["source-control"]`). Remotes point at `bitbucket.org`, but Bitbucket accepts API tokens only on `api.bitbucket.org`; on `bitbucket.org/!api/2.0` and `/api/2.0` the same token gets 401. An extension Git host can call only its instance origin, and the instance has to be the remote's host to bind, so the extension can't reach the API at all.

**What would you want instead?**

An optional API origin per instance that the extension declares and the user approves at install, like built-in GitHub talking to `api.github.com` for `github.com`. Binding would stay on the Git host; only API calls would go to the API origin. The token should still reach nothing but the forge, so restricting it to a subdomain of the instance host would be fine for me.

**Anything that shows what you mean (optional)**

As a workaround I built a plain extension with `integration.token` (`apiOrigin: https://api.bitbucket.org`, `scheme: basic`), a Work Status section and a rail panel. It works, but without the board, branch badges, worktree from a PR or the Changes tab.

---

## For the PR later (not part of the issue)

Where the pin lives in 2.7.0 (packaged `server/lib/source-control/`):

- `binding-service.js:55`: a remote binds only when its host equals the instance host.
- `outbound-handles.js:125`: `joinGuestRequestUrl(grant.origin, …)`, every outbound call is joined to the grant's origin.
- `extension-descriptor.js`: `instance.origin(instance)` is the single origin; `builtInDefaultHosts` keeps extensions off built-in hosts.
- Precedent for "a changed target invalidates the credential": `guests/oauth.js` `credentialTarget` / `sameTarget` (a stored token is used only while its target matches).

Design that keeps the security model:

- `apiOrigin` is static in the manifest and only for default instances (`instances.default`); custom user-typed instances get none in v1.
- Must be `https`, no path, and its host must be the instance host or a subdomain of it, so a manifest can't route the token to a third party.
- Shown on the install consent; an update that adds or changes it needs re-approval, and the stored token stops being used (key the credential by instance + apiOrigin).
- `builtInDefaultHosts` also applies to `apiOrigin`.
- Binding, SSH and clone stay on the instance host; only outbound handles are minted for `apiOrigin`. Redirects stay unfollowed. Audit and enterprise policy see the real origin.
- Tests: subdomain rule, refusal of a foreign/built-in host, token not sent after `apiOrigin` changes, binding unchanged.
