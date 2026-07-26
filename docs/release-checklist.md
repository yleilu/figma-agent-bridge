---
title: Release Checklist — the Operator's Half
created: 2026-07-26T17:30:00+08:00
tags:
  - figma-bridge
  - dev-ops
  - release
  - checklist
type: reference
---

# Release Checklist — the Operator's Half

The pipeline (`docs/specs/dev-ops.md` §7) runs every gate a runner can run. This is what it
cannot, and what you carry. The one-time bootstrap — the App, the ruleset, the trusted
publisher — is recorded at the end.

> **⚠ Merging any pull request into `main` cuts a release.**
>
> `.github/workflows/release.yml` triggers on `pull_request: [closed]`, and the only thing
> its job asks is `merged == true && base.ref == 'main'`. It does not know a release PR from
> any other pull request, because the platform cannot tell them apart — §5 says so in as many
> words ("nor a release pull request from any other pull request"). So a "trivial" or "quick
> doc fix" PR merged into `main` gates, bumps, builds and **publishes a real npm version**,
> which is immutable.
>
> §5's "a release pull request is the only merge into `main`" is a discipline you keep. This
> is what it costs when you don't. Ordinary work goes to `dev`; the one thing that may reach
> `main` another way is a hotfix **commit** (§5), which is not a pull request.

## Before the merge

- [ ] The release PR is from `dev` into `main`, titled `release: <one line>`, with a body
      carrying **Highlights**, **Breaking changes** (`none` when there are none), and
      **Upgrade notes**.
- [ ] Exactly one label. **Read §6.5 before choosing it.** Under principle B2 a breaking
      change is `release:minor`, *never* `release:major` — the label names the number it
      moves, not the size of the change.
- [ ] A non-empty **Breaking changes** section and the `release:minor` label imply each
      other. Checking that pair against itself is the one review a release PR needs beyond
      its gate.
- [ ] The pull-request gate is green.

## After the pipeline finishes

The **published form** of the install assertion (§4.2). It needs an authenticated Claude Code
host, which a CI runner is not and cannot be made into.

- [ ] Registry resolution, scripted:
      `bash scripts/assert-install.sh --registry <X.Y.Z>`
- [ ] The last mile, which no script reaches (`docs/specs/claude-plugin.md` §9.1, §9.4, §9.5):
      - [ ] `/plugin marketplace add yleilu/figma-agent-bridge` from a plugin cache with no
            prior copy, then `/plugin install figma-agent-bridge`
      - [ ] Claude Code resolved the npm-sourced **entry**, and
            `${CLAUDE_PLUGIN_ROOT}/bin/server.js` exists in the per-version cache copy
      - [ ] The MCP server connects; `figma-design` / `figma-reviewer` skills and agents load
      - [ ] `figma-setup` materialises `~/.figma-agent-bridge/figma-plugin/` with a manifest
            and both `dist/` files at the paths it reports
      - [ ] `record_feedback` writes a well-formed Markdown item to the store
- [ ] The back-merge of `main` into `dev` is **finished**. The pipeline starts it and hands
      over on conflict; a release is obliged to end with it complete (§5, §7 step 9).

## When the published-form check fails

A published version is immutable, so repair is forward (§4.2).

- [ ] Withdraw the version from resolution — `npm deprecate figma-agent-bridge@<X.Y.Z>
      "<why>"`, or unpublish where the registry still permits it.
- [ ] Mark the GitHub release as withdrawn, so the record says what happened. The release
      commit and its tag **stay**; nothing is rewritten.
- [ ] Ship the fix as a **new patch release**, the ordinary way. Until its release commit
      lands on `main`, the marketplace entry still names the withdrawn version — that
      interval is the whole urgency of the patch.

## Repository bootstrap

Done once. Recorded here because nothing else records it: the App's key rotates, people
ask why the pipeline may bypass `main`'s pull-request rule, and the answer has to be
findable.

### Two platform rules that shape everything below

- **`workflow_dispatch` is only offered for a workflow file that exists on the default
  branch.** `main` is the default branch (§5), so `release.yml` must live there or the
  **Run workflow** button never appears and `gh workflow run release.yml` fails.
- **`pull_request` workflows run from the pull request's merge ref**, not from the base
  branch. Together with the rule above, that is why `release.yml` is kept identical on
  `main` and on `dev` — and why the ⚠ at the top of this file is true.

### The release pipeline's identity: a GitHub App

`GITHUB_TOKEN` cannot do this job. It is not addable to a ruleset bypass list as a named
actor (§5 requires one), and a push made with it **does not trigger `push` workflows** — so
the back-merge onto `dev` would silently skip `ci.yml` and §4.4's promise would be false.

| Fact | Value |
| --- | --- |
| App name | `figma-agent-bridge-release` — **or whatever was free**: GitHub App names are globally unique |
| App slug | the lowercased/hyphenated name, visible at `https://github.com/settings/apps/<slug>`; stored as the `RELEASE_APP_SLUG` variable and used to build the commit author `<slug>[bot]` |
| Installed on | `yleilu/figma-agent-bridge` only |
| Repository permissions | `Metadata: Read-only` (mandatory) · **`Contents: Read and write`** — the release commit, the tag, the back-merge, the GitHub release · **`Workflows: Read and write`** — without it a back-merge carrying a hotfix that touched `.github/workflows/` is **refused** by GitHub |
| Deliberately NOT granted | `Actions` — nothing the pipeline does reads workflow runs; the one probe that did used `GITHUB_TOKEN` |
| Webhook | off |

### Credentials, and which kind each one is

| Name | Kind | Why |
| --- | --- | --- |
| `RELEASE_APP_ID` | repository **variable** | App IDs are not sensitive; the workflow reads `vars.RELEASE_APP_ID` |
| `RELEASE_APP_SLUG` | repository **variable** | not sensitive, and it changes only if the App is renamed |
| `RELEASE_APP_PRIVATE_KEY` | repository **secret** | the `.pem` in full, including the BEGIN/END lines |
| `FEEDBACK_WORKER_URL` | repository **secret** | baked into the server bundle at release time only; the release build **hard-fails** when it is empty |

**Rotating the App key:** generate a new private key on the App's settings page,
`gh secret set RELEASE_APP_PRIVATE_KEY < the new .pem`, then delete the old key on GitHub.
The App ID and slug do not change, so no variable and no workflow edit is involved.

### The `main` ruleset

Bypass list: **the release pipeline's App**, and **Repository admin** (the owner's hotfix
path, §5). The pipeline's writes are direct pushes, never pull requests (§5) — that is what
the bypass is for, and it is why the pull-request rule below does not contradict §7.

| Rule | State | Why |
| --- | --- | --- |
| Restrict deletions | **on** | |
| Block force pushes | **on** | §7: "There is never a rewrite of `main`" |
| Require a pull request before merging | **on**, 0 approvals, **merge commit only** | catches an unexempted writer; 0 approvals because the repository is solo — the rule exists to force the PR, not the review |
| Require status checks — `verify` | **on**, "require branches to be up to date" **off** | the up-to-date option would force a rebase-style update of `dev` before every release merge |
| Require linear history | **off — must stay off** | it forbids the true merge commit §5 mandates |
| Require signed commits | **off — must stay off** | the pipeline pushes over plain git and would be blocked |

`dev` carries a minimal ruleset — **Restrict deletions** and **Block force pushes** only,
and deliberately **no** pull-request requirement, because §5 allows work to reach `dev` by a
merge made locally and pushed.

### Repository settings

Merge commit **only** (squash and rebase disabled), and **delete-branch-on-merge off** —
`dev` is the head branch of every release PR, and auto-delete would remove the integration
branch on the first release.

### npm trusted publishing

Publishing is OIDC; no npm token is stored anywhere. On npmjs.com, the `figma-agent-bridge`
package → **Settings → Trusted Publisher → GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `yleilu` |
| Repository | `figma-agent-bridge` |
| Workflow filename | `release.yml` — **exact**; renaming the workflow breaks publish with a misleading `E404` |
| Environment | blank |

Token publishing is left **enabled** (i.e. "Require trusted publishing" unticked) so a token
fallback remains available if OIDC ever stops being accepted from the trigger in use.
