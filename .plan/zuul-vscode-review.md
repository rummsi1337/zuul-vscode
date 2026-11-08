# zuul-vscode review fixes — Implementation Plan

## Context

A whole-repo review of `.plan/zuul-vscode.md` and the code through Step 17. Nothing has been changed
yet. Each step below is one group of verified findings.

Facts checked on 2026-11-08:

- `npm run check` passes: 183 tests, 96.86 % lines, 90.36 % branches. Coverage excludes
  `src/views/**` and `src/extension.ts` (1,903 lines).
- `.git/hooks` holds only samples and `core.hooksPath` is unset, so `.pre-commit-config.yaml` has
  never run.
- `gitleaks` is installed at `/opt/homebrew/bin/gitleaks`. It found no leaks in 9 commits or in
  `src`, `test`, `.vscode`.
- `.github/workflows/ci.yml` (commit `032b56c`, added after the review) runs
  `pre-commit run --all-files` on Ubuntu, so every `language: system` hook must exist on that runner.
- `no-floating-promises` and `no-misused-promises` have 0 hits in `src/`.
- Every command in `package.json` is registered. `zuul.openBuildLog` and `zuul.openDependencyPr` are
  registered but deliberately not declared.
- Run directly: for `text\n`, add then remove returns `text`. In a body with mixed line endings, a
  `Depends-On` is listed but cannot be removed.
- VS Code 1.100 ships Node 20.19, and 1.101 is the first with Node 22 (secondary sources, not the
  official release notes). Global `WebSocket` needs Node 22.
- Confirmed by the user: on their GHE, the Zuul gate status is a required status check in branch
  protection, and gate only starts once all other required checks and Zuul's requirements are met.
- `GET /api/tenant/{t}/pipelines` returns only `name` and `triggers`, so Zuul's `require:` rules
  cannot be read through the API.
- Reading required checks: `getRequiredStatusChecks` already maps 403 and 404 to `undefined`, and may
  be refused for non-admins. GraphQL `Ref.refUpdateRule.requiredStatusCheckContexts` describes rules
  enforced on the viewer, but non-admin access on GHE is **not confirmed**.
- Confirmed by the user: not every user can read the branch protection API. Step 7's "required list
  unknown" path covers this. The required approval count stays future work (see
  `.plan/zuul-vscode.md`).
- Real Zuul shape, from `zuul.opendev.org` (Zuul 14.3.1.dev134, tenant `openstack`). OpenDev uses
  Gerrit, so re-check once against a GHE-backed Zuul:

  ```jsonc
  // GET /api/tenant/{t}/status/change/{id} returns an array of items:
  {
    "id": "e709c0c15708408390fe5331f5ca9680", // a UUID, not "42,sha"
    "active": true, "live": false,            // non-live items have "jobs": []
    "enqueue_time": 1700000000000, "remaining_time": 120000,
    "failing_reasons": [], "zuul_ref": "Z...",
    "item_ahead": "95f947a1b9cf4eafb3226ca1c3a99060", // UUID string or null, never an object
    "items_behind": ["634d7ad3af2d4cc6b62a48f8404b7615"],
    "refs": [{ "id": "990923,36", "owner": "x", "project": "openstack/cinder",
               "project_canonical": "opendev.org/openstack/cinder", "ref": "refs/changes/23/990923/36",
               "url": "https://review.opendev.org/c/openstack/cinder/+/990923" }],
    "jobs": [{ "name": "j", "uuid": "731f...", "result": "SUCCESS", "voting": true, "pipeline": "check",
               "url": "stream/731f...?logfile=console.log",          // relative
               "report_url": "https://zuul.opendev.org/t/openstack/build/731f...", // a web page, not logs
               "elapsed_time": 1, "remaining_time": 0, "canceled": false, "paused": false, "queued": false }]
  }
  // There is no item-level "pipeline" or "queue". Those live on the enclosing objects in
  // GET /status: pipelines[].name, pipelines[].change_queues[].name, change_queues[].heads[][].
  // Builds API items carry log_url, voting, artifacts and a nested ref { project, change, patchset }.
  // /nodesets, /project-templates, /semaphores and /jobs all return 200.
  ```

## Goal

The extension never reports a false "Ready for gate", works against the real Zuul API, keeps tokens
safe, explains every empty or failed state, and has one copy of each piece of logic. The plan matches
the code, and the pre-commit checks run.

## Conventions

- Acceptance command for every step: `npm run check`.
- Follow the Conventions section of `.plan/zuul-vscode.md`, as corrected by Step 2.
- No git state changes (commit, add, stash, checkout, branch, push).
- Every behaviour change gets a test in the same step. Line numbers are from 2026-11-08 and may have
  moved after earlier steps, so find the code by name.

## Steps

### Step 1: Make pre-commit run and close its gaps

- **Tier:** self
- **Risk:** low
- **Status:** done
- **Files:** `.pre-commit-config.yaml`, `eslint.config.mjs`, `.vscodeignore` (edit);
  `vitest.config.ts` (rename to `vitest.config.mts`);
  `test/unit/manifest.test.ts`, `.markdownlint.json` (new)
- **Do:**
  - Replace the two local hooks with these `local`, `language: system`, `pass_filenames: false` hooks:
    - `check`: `npm run check` (lint, typecheck, tests with coverage, build).
    - `lockfile-sync`: `npm ci --dry-run --ignore-scripts`, with `files: ^package(-lock)?\.json$`.
  - Add `pre-commit/pre-commit-hooks` pinned to its latest tag, with `check-merge-conflict` and
    `check-added-large-files` (`args: [--maxkb=500]`; `package-lock.json` is 235 KB).
  - Added at the user's request: `trailing-whitespace` (`args: [--markdown-linebreak-ext=md]`) and
    `igorshubovych/markdownlint-cli` `v0.50.0`, excluding what Prettier also skips (`.plan/`,
    `IMPLEMENTATION_PLAN.md`). `.markdownlint.json` turns off `MD013`, as prose is not wrapped.
  - In `eslint.config.mjs`, add a block for `src/**/*.ts` with
    `parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }` and the rules
    `@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-misused-promises` as errors.
  - Rename the vitest config to `.mts` (removes the Vite warning) and update `.vscodeignore`.
  - `manifest.test.ts`: read `package.json` and all `src/**` text. Assert every `contributes.commands`
    entry, every `menus` command and every `command:zuul.*` welcome link is registered, and every
    registered `zuul.*` command is declared except `zuul.openBuildLog` and `zuul.openDependencyPr`.
  - Run `pre-commit install`, then `pre-commit run --all-files`.
- **Don't:** add `no-commit-to-branch` (work happens on `main`). Don't add end-of-file, JSON or
  YAML hooks, because Prettier already fails on those. Don't enable all of
  `recommendedTypeChecked` (49 unrelated hits).
- **Done when:**
  - `.git/hooks/pre-commit` exists
  - `pre-commit run --all-files` passes

### Step 2: Correct the main plan and raise the engine floor

- **Tier:** self
- **Risk:** low
- **Status:** done
- **Files:** `.plan/zuul-vscode.md`, `package.json`, `package-lock.json`, `esbuild.mjs` (edit)
- **Do:**
  - Code: `engines.vscode` to `^1.101.0`, `@types/vscode` to `~1.101.0` (run `npm install`), esbuild
    `target` to `node22`.
  - Plan edits, by current line:
    - 8-9: repo state is stale. 40: "Steps 2–34". 62-63: add the `[Git]` tag. 1055: VS Code ≥ 1.101.
    - 18-20 and 282-283: replace the assumed Zuul shapes with the real one above.
    - 47-60: services may import `vscode` only as thin adapters; exclude `src/language/*Provider.ts`
      and `*Lens.ts` from coverage (Step 24-27 adapters would otherwise fail the 80 % threshold).
    - 64-65 and 339: use one rule. A 401 offers Sign in. A 403 offers Sign in only on user-started
      commands and never for rate limits. Neither deletes a stored token.
    - 78, 162, 311: default `zuul.auth.method` is `auto` from now on (Step 11), order `pat`, `gh-cli`.
    - 420: the in-editor viewer arrives in Step 20, not 19.
    - 567-568, 594, 596-598: record the decisions in Step 7 below, and add
      `zuul.gate.gateStatusChecks` to the settings table.
    - 660-665 (Step 19): add `buildsModel.ts` and its test to Files. `report_url` is a web page, so get
      `log_url` and `artifacts` from `GET /build/{uuid}` on expand. Say what replaces
      `zuul.openBuildLog`. 662-670: use `iconPath`; plain tree labels do not render `$(...)`.
    - 686 (Step 20): add a size-limited streaming read, because `getText` buffers the whole body.
    - 764-765 (Step 23): use `yaml.parseAllDocuments`; default a nameless `- project:` to the current
      project. Assign the `watchWorkspaceConfig` wiring to Step 24. Add Step 22's fixture to Files.
    - 924-934, 968 (Steps 29-30): add `authService.ts` and its test to Files. Add a `method?` override
      to `getToken`. Non-interactive OAuth returns `undefined` unless the host is configured. Read both
      `github-enterprise.uri` and `.uris`. State how Step 30 learns the host.
    - 983-989 (Step 31): try every provider with `interactive: false` first, then show the QuickPick;
      a cancelled sign-in returns `undefined`. Add `zuulContext.ts`, `statusBarText.ts`, `statusBar.ts`
      and the test to Files. Show the status-bar sign-in on "context resolved and `zuul.signedIn` is
      false".
    - 1036-1041 (Step 33): allow a test API returned from `activate`; add `gheClient.ts`, a test bundle
      step and mocha types. 1067: run `npm run format` first.
    - 1069-1076: add fork-based workflows to Out of scope. Add the untracked vision items (review
      status, role and variable help, branch-protection approvals, sidebar toolbar) to Deviations.
    - Record `zuul.openBuildLog`, `zuul.openDependencyPr` and `zuul.contextProblem`.
- **Done when:**
  - `npm run check` passes
  - `grep -n "no commits" .plan/zuul-vscode.md` finds nothing

### Step 3: Remove duplicated logic

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/services/buildsModel.ts`, `statusBarText.ts`, `gateFacts.ts`, `dependsOnService.ts`,
  `dependsOnParser.ts`, `triggerService.ts`, `prTracker.ts`; `src/views/addDependsOnPick.ts`,
  `dependsOnTreeView.ts`, `buildsTreeView.ts`, `prGateTreeView.ts`, `statusBar.ts`;
  `src/auth/*`; `src/git/remoteUrl.ts`; `src/clients/gheClient.ts`, `zuulClient.ts`;
  `src/context/zuulContext.ts`; `src/extension.ts`; `src/config/settings.ts`; `src/util/concurrency.ts` (new)
- **Do:**
  - Export `getBuildTime` and `getLatestBuildsPerJob` from `buildsModel.ts`; delete the copies in
    `gateFacts.ts:225,241` and `statusBarText.ts:51,67`.
  - Move `mapWithConcurrency` to `src/util/concurrency.ts` (copies at `dependsOnService.ts:131`,
    `gateFacts.ts:450`).
  - Export `formatPrRef` and `prRefKey` from `dependsOnParser.ts`. Replace `refKey`, `formatPrRefKey`,
    `formatRefKey`, `candidateKey` and the inline `${owner}/${repo}#${n}` strings.
  - Use `classifyJobResult` as the only result classifier. Delete `FAILURE_RESULTS` and `isJobFailure`
    in `statusBarText.ts` and `isSuccessfulZuulResult` in `gateFacts.ts`.
  - Add `pickPrimary(items, getPipeline)` (gate, then check, then first) for `selectStatus`,
    `selectBuildPipeline` and `selectPrimaryStatus`.
  - Add `normalizeHost` to `src/git/remoteUrl.ts` and use it for all `host.trim().toLowerCase()` sites.
    Drop the re-normalising inside providers, since `AuthService` already did it.
  - Merge `isProjectInTenant` and `isCandidateInTenant` into one `isInTenant(owner, repo, set)`. The set
    stores only lowercased normalised names and uses `has`.
  - Reduce `extractPrCoordinates` to reading `pr.base.repo.full_name`. Delete `resolvePrCoordinates`
    and the empty-owner guards.
  - In `addDependsOnPick.ts`: delete `initialShowQuickPick` and both `showQuickPick` fallbacks, always
    use `createQuickPick`, use `vscode.QuickPickItemKind.Separator` directly, read `picked.candidate`
    instead of `coerceDirectCandidate` (keep string and `{url}` arguments), drop `repository_url`.
  - Add optional `clearCache?()` to `TokenProvider` and delete the cast at `authService.ts:70-75`.
  - Drop camelCase aliases in `RawBuild`/`RawBuildset`. Add `isStringArray` and `isPlainObject` to
    `settings.ts`. Add a local `upsert` in `mapRollupChecks`/`mapRestChecks`. Un-export the unused
    types listed by name: `OutOfSyncRootNode`, `OutOfSyncChildNode`, `DependsOnGroupNode`,
    `NeededByGroupNode`, `GateHeaderNode`, `GatePrNode`, `HttpClientOptions`, `ZuulPlaybookRef`,
    `BuildArtifact`.
- **Don't:** fix behaviour beyond the classifier here. Keep test-only exports of pure functions.
- **Done when:**
  - `npm run check` passes
  - `git diff --stat` shows `src/` shrinking by at least 250 lines
  - Status bar test: `CANCELED`, `ABORTED`, `MERGE_CONFLICT` and `CONFIG_ERROR` are not "PASSED"

### Step 4: Move decision logic out of views and test it

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/views/addDependsOnPick.ts`, `dependsOnTreeView.ts`, `prGateTreeView.ts`,
  `src/services/dependsOnService.ts`, `test/unit/dependsOnService.test.ts` (edit);
  `src/services/dependsOnCandidates.ts`, `dependsOnPresentation.ts`, `gatePresentation.ts`,
  `src/services/keyedAsyncCache.ts` and one test file for each (new)
- **Do:**
  - The four new modules must not import `vscode` (coverage counts them, and the test mock has no
    `QuickPickItemKind`).
  - Move to `dependsOnCandidates.ts`: `DependsOnCandidate`, `parsePrUrlCandidate`,
    `searchItemToCandidate`, `buildTenantProjectSet`, `buildSectionedQuickPickItems`,
    `toQuickPickItem`, and `HTTP_PR_URL_RE`. `buildSectionedQuickPickItems` returns plain
    `CandidateRow[]`: the fields `toQuickPickItem` sets today, plus `separator?: true` on section
    headers (replaces `makeSeparator`). `DependsOnQuickPickItem` stays in the view. Add a local mapper
    in `addDependsOnPick.ts` that turns a `separator` row into
    `{ label, kind: vscode.QuickPickItemKind.Separator }` and passes other rows through.
  - Move to `dependsOnPresentation.ts`: the `formatUpstream*` functions, `resolveUpstreamUrl`,
    `getUpstreamIconId`, `formatDownstreamLabel`, `extractRemovalCoordinates` (now exported).
  - Move to `gatePresentation.ts`: `formatGateHeader`, `buildGateChildren` and the `GateTreeNode`
    types.
  - Add `KeyedAsyncCache<T>` in `src/services/keyedAsyncCache.ts`. It holds one entry at a time:

    ```ts
    constructor(ttlMs: number, now: () => number = Date.now)
    peek(key: string): T | undefined   // last stored value for this key, even if expired
    isFresh(key: string): boolean      // stored for this key and age < ttlMs
    get(key: string, load: (isCurrent: () => boolean) => Promise<T>): Promise<T>
    invalidate(): void                 // drops the stored value and the running load
    ```

    `get` returns the fresh value, else joins the running load for this key, else calls `load`
    synchronously. A newer load or `invalidate()` makes a running load stale: `isCurrent()` turns
    false, its result is not stored, and it cannot clear the newer load's in-flight entry. A rejected
    load stores nothing. Age counts from when the load finished.
  - `PrGateTreeDataProvider`: `KeyedAsyncCache<GateReport>` with `GATE_REFRESH_MIN_INTERVAL_MS`
    replaces `cached`, `inflight` and `CachedReport`. Keep the key as it is. The load callback logs
    the existing warning and rethrows; `getReport` catches and returns `cache.peek(key)`, so a failed
    load is not stored and retries on the next call, as today. `invalidateCache()` calls `invalidate()`.
  - `DependsOnTreeDataProvider`: `KeyedAsyncCache<void>` with `DEPENDS_ON_REFRESH_TTL_MS` replaces
    `lastFetchedAt`, `inFlightPromise` and `fetchSeq`. Key: `${prKey}\n${body}`.
    - Rows stay in `upstream`, `downstream` and `hasLoadedOnceForPr`, so old rows still show while a
      changed body loads.
    - `cachedPrKey` and `cachedBody` stay. Set them at the top of the load callback, and clear them
      where they are cleared today.
    - The load callback checks `this.disposed || !isCurrent()` in place of the `seq` check. It catches
      and logs errors itself, so a failed load counts as done and waits for the TTL, as today.
    - `needsFetch` becomes: `prKey` is defined and `!cache.isFresh(key)`.
    - Delete the `else if (this.inFlightPromise)` branch in `getChildren`. `needsFetch` is now true
      during a load, and `get` joins it.
    - `invalidateCache()` calls `invalidate()` and still clears `cachedBody`. The no-snapshot path in
      `handleSnapshotChange` calls `invalidate()` in place of its `fetchSeq` and `inFlightPromise` lines.
  - Add to `dependsOnService.ts`, both returning `Promise<void>` and taking
    `ghe: Pick<GheClient, 'getPr' | 'updatePrBody'>` and `ref: PrCoordinates`:
    `applyAddDependsOn(ghe, ref, url)` and
    `applyRemoveDependsOn(ghe, ref, target: { owner: string; repo: string; number: number })`.
    Each does a fresh `getPr`, edits with `addDependsOn` or `removeDependsOn`, then `updatePrBody`.
    The callers keep their log lines, `onUpdated` and refresh calls. The `this.disposed` check between
    `getPr` and `updatePrBody` goes away, because the user has already confirmed the edit.
- **Don't:** change labels, order or behaviour, beyond the cache rules written above.
- **Done when:**
  - `npm run check` passes
  - Moved modules count toward coverage and each has its own test file
  - `grep -l "from 'vscode'"` on the four new modules finds nothing
  - `keyedAsyncCache.test.ts` covers: TTL expiry, joining a load for the same key, a newer key making
    the old load stale, `invalidate()` dropping a running load, a rejected load storing nothing
  - `dependsOnService.test.ts` covers both `apply*` functions using the fresh body, not a stale one

### Step 5: Match the real Zuul status API

- **Tier:** sonnet
- **Risk:** high
- **Status:** done
- **Files:** `src/clients/zuulClient.ts`, `src/clients/zuulTypes.ts`, `src/services/buildsModel.ts`,
  `src/services/prTracker.ts`, `.plan/zuul-vscode.md`, `test/unit/zuulClient.test.ts`,
  `test/unit/buildsModel.test.ts`, `test/unit/prTracker.test.ts`,
  `test/fixtures/zuul/status-modern.json`, `status-legacy.json`
- **Do:**
  - Rewrite `status-modern.json` to the shape in Context (`jobs` with one running and one finished;
    GitHub-style `refs[].id` such as `"42,abc123"`). Add a non-live item with `jobs: []`.
  - `normalizeChangeStatus`: `pipeline` = `raw.pipeline`, else the first non-empty `jobs[].pipeline`,
    else `''`. `item_ahead` is a string or null, so stop calling `toQueuedRef` on it.
  - A `refs[]` entry other than the target is a bundle member, so it is no longer an item ahead. Read
    the change number from `ref.id` and do not expect `change`, `patchset` or `ref_url`.
  - Add `voting?: boolean` to `JobStatus` and `Build`, and map it.
  - `url` on jobs is relative. Build `streamUrl` from the base URL, or remove it if nothing uses it.
  - Added after review: a non-live item with `jobs: []` says nothing about this PR's builds.
    `buildTree` drops statuses with `!live && jobs.length === 0` before its length check, so the
    builds branch runs. `PrTracker` calls `listBuilds` when `statuses.every((s) => !s.live)`.
  - Added after review: in `status-modern.json` the non-live item's only ref is
    `42,9f8e7d6c5b4a3210`, and the two items are not linked: the first item's `item_ahead` and
    `items_behind` use UUIDs that are not in the array.
  - Added after review: in `.plan/zuul-vscode.md`, remove `streamUrl` from the `JobStatus` listing and
    add `voting?: boolean` to the `JobStatus` and `Build` listings.
- **Done when:**
  - `npm run check` passes
  - Tests assert `pipeline: 'check'` from `jobs[].pipeline`, a non-live item, and `voting: false`
  - Tests assert `normalizeBuild` keeps `voting: false`, and `buildTree` carries `voting` on both the
    statuses and the builds paths
  - Tests: `buildTree` with only a non-live empty item falls through to builds; `PrTracker` calls
    `listBuilds` when every status is non-live and not when one is live

### Step 6: Make the Zuul sync check work

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/clients/zuulClient.ts`, `src/services/dependsOnService.ts`,
  `src/views/dependsOnTreeView.ts`, tests
- **Do:**
  - Add `getQueueAhead(tenant, pr, sha): Promise<QueuedRef[] | undefined>`: `GET /status` (no cache), find
    the item whose `refs[].id` is `<pr>,<sha>`, follow `item_ahead` UUIDs, return `project`, `change`,
    `live`, `url`. Added after review: return `undefined` when no item matches, so a PR that just left
    the queue does not show all its dependencies as missing.
    Read `change` from `ref.id` through the `id` path `parseChangeNumber` still has for this. Step 5 left
    `ChangeStatus.itemsAhead` as `[]`, so these refs are the only source of queue data.
  - Call it only when the PR has Depends-On lines and statuses exist, at the existing 60 s cadence.
  - `syncState` uses those refs. An item counts as extra only if it is outside the transitive upstream
    set (walk `Depends-On` bodies, depth 5, 50 PRs). A→B→C must be in sync when the body of A lists B.
  - Update Deviation 2 in `.plan/zuul-vscode.md`.
- **Don't:** call `/status` on every poll.
- **Done when:**
  - `npm run check` passes
  - Tests cover in sync, missing, transitive not extra, removed dependency reported as extra

### Step 7: Stop false "Ready for gate"

- **Tier:** sonnet
- **Risk:** high
- **Status:** done
- **Files:** `src/services/gateFacts.ts`, `src/services/gateReadiness.ts`, `src/clients/gheClient.ts`,
  `src/views/prGateTreeView.ts`, `src/config/settings.ts`, `package.json`, tests
- **Do:**
  - `collectUpstreamFacts`: on any error return blocking facts (`state: 'open'`, `zuulCheck: 'none'`,
    one required check `{ name: 'Could not read this pull request', state: 'error' }`). Do the same
    with `'Dependency chain deeper than 5 levels'` for refs left when the depth limit is reached.
    Also set `loadError` to that message, so `evaluatePr` reports one blocker, not one per placeholder.
  - `summarizeReviews`: skip `COMMENTED` and `PENDING` before picking the latest per user.
  - `collectGateFactsInternal`: await the fresh PR first, use its `head.sha`. If the rollup `oid`
    differs, add a required `pending` check `'Head commit changed while checking'`.
  - Merge state: block on `dirty`, `blocked` (one exception, see the Zuul gate rule below), `unknown`
    and absent; pass `clean`, `behind`, `unstable`, `has_hooks`, `draft`. Rollup
    `mergeable === 'CONFLICTING'` blocks as `dirty`.
  - Required checks list: add `getRequiredContexts(owner, repo, branch): Promise<string[] | undefined>`
    to `gheClient.ts`. First try GraphQL
    `repository { ref(qualifiedName: "refs/heads/<branch>") { refUpdateRule { requiredStatusCheckContexts } } }`
    as its own query, so an older GHE without the field fails only this query. On an error or null,
    fall back to REST `getRequiredStatusChecks`. Use it on both the rollup and REST paths, add
    `missing` entries for names that have not reported, and set the new fact
    `requiredChecksKnown: boolean`. In `evaluatePr`, the list also counts as known when
    `zuul.gate.requiredStatusChecks` names checks for this repo.
  - Same-named checks: keep the worst state (error, failure, missing, pending, success).
  - `listCommitStatuses` and `listCheckRuns`: `per_page=100` and pagination. Log when a limit truncates.
  - zuulCheck: use only `live` statuses whose pipeline is `check` or `''`. A failed `voting === false`
    job doesn't count. An unfinished one still counts as running: Zuul only reports once every job has
    finished.
  - `evaluateGate`: stop pushing `upEval.blockers` into `blockers` (each upstream problem counted
    twice); upstream detail stays in `items`.
  - `prGateTreeView`: on failure return a not-ready report with one blocker `Could not load gate data:
    <message>`, never a cached "Ready". Add host, owner, repo and the rules to the cache key.
  - Zuul gate rule. New setting `zuul.gate.gateStatusChecks`, default `["{tenant}/gate"]`, described as
    "Status checks that only report once a pull request enters Zuul's gate". The caller substitutes
    `{tenant}` and passes the result as `GateRules.gateStatusChecks`; names match case-insensitively.
    `{tenant}` is also substituted in `zuul.gate.requiredStatusChecks`.
    Per PR, for a check with one of those names:

    | Check state | Result |
    | --- | --- |
    | absent or `missing` | Not a blocker. Row `Zuul gate`, ok, message `Starts once everything else is done` |
    | `pending` | Not a blocker. Row `Zuul gate`, ok, message `Running` |
    | `success` | Ok |
    | `failure`, `error` | Blocker, kind `status-check`: `Zuul gate failed on this commit. It needs a new trigger.` |

  - `blocked` is excused only when all of these hold: the required list is known; a gate status check
    is in that list and is absent or pending; every other required check is `success`; the PR has
    no other blocker; and no other branch rule could be the cause (next bullet). Then show row
    `Merge state`, ok, message `Blocked only by the Zuul gate`.
  - `blocked` has causes the status checks don't show. Add `getBranchMergeRules(owner, repo, branch)`
    (its own query) reading `requiredApprovingReviewCount`, `requiresConversationResolution` and
    `requiresSignatures` from `refUpdateRule`. Don't excuse `blocked` when conversations or signatures
    are required, or when approvals are short of the count and the review decision isn't `APPROVED`.
    If these rules can't be read, only a list in `zuul.gate.requiredStatusChecks` for this repo allows
    the excuse.
  - If the required list is unknown, `blocked` stays a blocker with the message `Merge is blocked, and
    this repo's required checks can't be read. List them in zuul.gate.requiredStatusChecks to tell
    whether only the Zuul gate is left.` Never excuse `blocked` on a guess.
  - Zuul's `require:` rules can't be read through the API. Say in the descriptions of
    `zuul.gate.requiredApprovals` and `zuul.gate.requiredLabels` that they should mirror the gate
    pipeline's requirements.
- **Done when:**
  - `npm run check` passes
  - The test at `test/unit/gateFacts.test.ts:707` now expects a blocker
  - New tests: upstream 500 gives a blocker; `[APPROVED, COMMENTED]` keeps the approval;
    `[CHANGES_REQUESTED, COMMENTED]` still blocks; table of merge states; rollup with an unreported
    required check; non-voting failure passes; 31 check runs across pages; one upstream problem
    counts as one blocker; gate status table (absent, pending, success, failure); `blocked` excused
    when only the gate is outstanding; `blocked` still blocks when the list is unknown, when another
    required check has not reported, when the gate check is not in the required list, or when another
    branch rule could be the cause; `getRequiredContexts` falls back from GraphQL to REST

### Step 8: Protect tokens and stop the 401 noise

- **Tier:** sonnet
- **Risk:** high
- **Status:** done (`npm run check` stops at Prettier only on the untracked `future-work.md`; eslint, tsc, tests and build all pass)
- **Files:** `src/clients/http.ts`, `src/clients/gheClient.ts`, `src/context/zuulContext.ts`,
  `src/context/tenantResolver.ts`, `src/auth/*`, `src/config/settings.ts`, `src/extension.ts`,
  `src/views/buildsTreeView.ts`, `src/views/dependsOnTreeView.ts`, tests
- **Do:**
  - Corrected 2026-11-08 after commit `803e5ea` (per-tenant Zuul tokens), which landed after this step
    was written and changed `http.ts`, `zuulClient.ts`, `tenantResolver.ts` and `zuulContext.ts`.
  - `http.ts`: send `Authorization` only when the request URL has the same origin as `baseUrl`. The
    GHE GraphQL URL must keep its token (test github.com and GHE). Zuul tokens arrive as a per-call
    header from `ZuulClient.withAuth`, not from `getAuthHeader`. So pass the URL into `buildHeaders`
    and, for another origin, skip `getAuthHeader` and also delete any `Authorization` in the `extra`
    headers.
  - Delete `PatAuthProvider.invalidate`; a 401 must not erase a stored token. Keep `invalidate?` on
    `TokenProvider` and `GhCliAuthProvider.invalidate` (it only drops a cached token). Change the
    `reportUnauthorized` log text from `invalidating credentials` to `clearing cached credentials`.
  - `AuthService`: in `resolveToken`, a provider that throws is logged as a warning and counts as no
    token (move on to the next provider). `getToken` still reports the result.
  - `wrappedFetch` in `zuulContext.ts` (GHE only). On a 401:
    - No `Authorization` on the request (read it with `new Headers(init?.headers)`): return the
      response unchanged, with no `reportUnauthorized` and no toast.
    - With one: always call `auth.reportUnauthorized`, so a renewed `gh` token is picked up. Toast
      only if that `Authorization` value differs from the last one toasted for this host (a
      `Map<host, value>`, like `zuulAuthNotices`).
  - Delete `wrapGheClient` and `handleGheError` (that proxy is its only caller). Every 401 already goes
    through `wrappedFetch`, so the proxy is dead in production. Keep `handledErrors` and the Zuul
    proxy: `handleZuulError` uses them. Only remove the GHE uses of `handledErrors`. Rewrite the two
    GHE 401 tests in `zuulContext.test.ts` (`passes interactive: false to auth.getToken ...` and
    `does not trigger reportUnauthorized ...`) to use a fake fetch.
  - `getPrRollup`: rethrow 401 and 403 instead of swallowing them.
  - `encodeURIComponent` owner and repo in GHE paths. `openExternal` only for http/https.
  - `zuul.ghe.host`: strip scheme and path in `readWorkspaceSettings` (`settings.ts`), the one place
    it is read. Keep a port if there is one.
  - `resolveTenant`: the per-tenant try/catch already skips 401 and 403. Widen it so any error skips
    that tenant and the first non-auth error is kept. If no tenant matches, throw
    `authError ?? otherError`, so Step 10 can still report network and 5xx errors. `matchesProject`
    compares lowercase. New signatures: `resolveTenant(zuul, host, project, configured, cache)` and
    `tenantCacheKey(zuulUrl, host, project)`, with `host` passed through `normalizeHost`.
    `zuulContext.ts` passes `gitCtx.host`. Old cache entries are simply ignored.
  - `setGhePat` and `clearGhePat`: after a successful change, `showInformationMessage`
    (`Saved token for <host>` / `Removed token for <host>`; a notice, not a question) and
    `await vscode.commands.executeCommand('zuul.refresh')`. Do neither if the user cancelled.
- **Done when:**
  - `npm run check` passes
  - Tests: a `Link` to another origin gets no token; a per-call `Authorization` to another origin is
    dropped; a 401 keeps the PAT; repeated 401s give one toast; a changed token gives a new toast; no
    token gives no toast; a throwing provider reports signed out; a tenant that fails with a 500 does
    not stop a later tenant matching; a 500 with no match still rejects

### Step 9: Make Depends-On edits and PR targeting safe

- **Tier:** sonnet
- **Risk:** high
- **Status:** todo
- **Files:** `src/services/dependsOnParser.ts`, `dependsOnService.ts`, `gateFacts.ts`, `prTracker.ts`,
  `triggerService.ts`, `dependsOnCandidates.ts`, tests
- **Do:**
  - `addDependsOn` keeps the body's trailing line ending after the new line. `removeDependsOn` processes
    each line with its own ending, removes only blanks the removal created, and restores one trailing
    ending if the input had one.
  - Log a warning instead of "Removed" when the body did not change. Skip the PATCH when the new body
    equals the fresh body. Run the cycle check on the fresh body.
  - `parsePrUrlCandidate`: use `rawHost.toLowerCase()`, never `fallbackHost`, when a URL has a host.
  - Keep `host` in `extractValidDependsOnRefs` and in the ref keys. A ref on another host gives blocking
    facts in the gate and `state: 'missing'` with a warning in `getUpstream`.
  - `prTracker.handleContextChange`: when host, owner, repo or branch changes, clear the snapshot and
    emit before polling (not on `headSha`-only changes).
  - `TriggerService.post`: take owner and repo from `snapshot.pr.base.repo.full_name`. Stop waiting when
    the snapshot becomes undefined.
- **Don't:** skip `Depends-On` lines inside code fences. Zuul's own pattern matches them too; add a test
  that documents this.
- **Done when:**
  - `npm run check` passes
  - Tests: round trips for `text`, `text\n`, `a\r\nb\r\n`; removal from a mixed body; `http://other/...`
    keeps its host; a branch switch clears the snapshot; a fresh body differing from the snapshot is used

### Step 10: Explain loading, empty and failed states

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `package.json`, `src/extension.ts`, `src/context/zuulContext.ts`, `src/services/prTracker.ts`,
  `src/views/statusBar.ts`, `prGateTreeView.ts`, `dependsOnTreeView.ts`, `buildsTreeView.ts`, tests
- **Do:**
  - Set `zuul.contextProblem` to `loading` at activation, and to `none` only once `zuulContext.current`
    is defined. Add `zuul.authChecked`, set after the first token lookup. Use
    `zuul.authChecked && !zuul.signedIn` for the no-token welcome (`== false` also matches unset).
  - Give all three views the same `viewsWelcome` ladder: no folder, no repo, no `zuul.url`, no tenant,
    unreachable, loading, no token, no PR. Exactly one clause may match. Builds' "no builds yet" needs
    `zuul.hasPr`.
  - Add problem `zuul-unreachable` for network and 5xx errors during tenant discovery: "Could not reach
    Zuul at the configured URL. Check `zuul.url` and your network, then [Refresh](command:zuul.refresh)."
    Keep `no-tenant` for "reachable, repo not in any tenant".
  - `zuul.refresh` calls `zuulContext.recompute()` first.
  - A failed load in Dependencies shows one node `Could not load dependencies, click to retry`, never
    "Depends On (0)".
  - `PrTracker` exposes the last poll error. The status bar shows
    `$(warning) Zuul: offline, last update HH:MM` (click runs `zuul.refresh`). No toast per poll.
  - Set stable `item.id` on tree items so collapsed nodes stay collapsed.
- **Done when:**
  - `npm run check` passes
  - A test walks each ladder state in `package.json` and asserts exactly one clause matches per view

### Step 11: Give commands and the status bar honest feedback

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `package.json`, `src/extension.ts`, `src/services/statusBarText.ts`, `triggerService.ts`,
  `src/views/*`, `src/config/settings.ts`, tests
- **Do:**
  - Wrap command handlers: errors become `Could not post "recheck" on org/repo#12: <short reason>`. 401
    and non-rate-limit 403 add a Sign in action. Add `.catch` on `zuulContext.ready`.
  - Default `zuul.auth.method` to `auto`, remove `oauth` from the enum until Step 29, and describe each
    method. Mark `zuul.ghe.oauthClientId` "Not used yet".
  - Add `&& zuul.hasPr` to every non-refresh `view/title` entry.
  - Replace silent `false` returns with `No pull request found for the current branch.`
  - After posting, `setStatusBarMessage('Posted "recheck" on #12', 4000)`. Timeout text:
    `Zuul has not reacted to "recheck" yet. It may still be queued.` with Refresh.
  - Status bar: ignore items with `!live && jobs.length === 0`; `total === 0` gives
    `$(clock) Zuul <pipeline>: queued`; all jobs done without failure
    gives `$(check) ... passed`; empty pipeline omits the name; PASSED only if every latest build is
    success or skipped; mark non-voting failures as not failing.
  - Text: `1 blocker` / `2 blockers`; drop `$(warning)` from the out-of-sync label; remove the literal
    backticks from the `zuul.url` notification; link Gate PR rows to the PR.
  - Replace the `[Zuul]` tag with `[GHE]` on GHE work.
- **Done when:**
  - `npm run check` passes
  - Tests cover `0/0`, all done, empty pipeline and the error wrapper

### Step 12: Harden the remaining tests

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `test/helpers/*` (new), `test/unit/*`, `test/mocks/vscode.ts`, `vitest.config.mts`
- **Do:**
  - Add `test/helpers` with `createFakeLogger`, `makePr`, `makeResolvedContext`, and use them everywhere.
  - `prTracker`: stale response after a context change (deferred promise), and `refresh()` racing a timer.
  - Replace the real `setTimeout(10)` at `dependsOnService.test.ts:228` and `gateFacts.test.ts:679`.
  - Split the omnibus tests at `triggerService.test.ts:402` and `prTracker.test.ts:418`.
  - Add a fixture-driven test: `collectGateFacts` over the real-shaped fixtures, then `evaluateGate`.
  - Add `thresholds.perFile: true`, and type the mock with `satisfies Pick<typeof import('vscode'), ...>`.
- **Done when:**
  - `npm run check` passes with per-file thresholds on

### Step 13: Show review status on upstream PRs

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/services/dependsOnService.ts`, `src/services/dependsOnPresentation.ts`,
  `test/unit/dependsOnService.test.ts`, `test/unit/dependsOnPresentation.test.ts`
- **Do:**
  - Add `review?: 'approved' | 'changes requested' | 'review required'` to `UpstreamDep`, mapped from
    `reviewDecision`.
  - In `getUpstream`, for open PRs only, call `ghe.getPrRollup(owner, repo, n)` after `getPr`. A
    missing rollup, a null `reviewDecision` or a thrown error leaves `review` unset and never
    changes `state`.
  - `formatUpstreamDescription`: `open · approved · <zuul summary>`. Leave out the middle part when
    `review` is unset. `formatUpstreamTooltip`: add a line `Review: approved`.
- **Don't:** call `listReviews` or read branch protection. `reviewDecision` needs only read access
  to the PR.
- **Done when:**
  - `npm run check` passes
  - Tests: each `reviewDecision` maps to its text; a merged PR makes no rollup call; a failing
    rollup keeps `state: 'open'` with no `review`

### Step 14: Show trigger comments as rows in Gate Readiness

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/services/gatePresentation.ts`, `test/unit/gatePresentation.test.ts`,
  `src/views/prGateTreeView.ts`
- **Do:**
  - VS Code menus are static, so the toolbar can't have one button per configured trigger. Tree rows
    can.
  - `buildGateChildren`: add a last root node `Triggers` (expanded) with one child per
    `zuul.triggerComments` entry, only when there is at least one. Pass the list in as a parameter
    so the function stays pure.
  - `prGateTreeView` renders each child with label = trigger `label`, description = `comment`,
    `iconPath: new vscode.ThemeIcon(icon ?? 'comment')` and
    `command: { command: 'zuul.postTrigger', arguments: [comment] }`. That command already accepts a
    comment and shows the confirmation modal, so no new command is needed.
  - `prGateTreeView` reads the list with `readWorkspaceSettings()` at render time and re-renders on
    `onSettingsChanged`.
- **Don't:** remove the toolbar button, add a webview, or count these rows as blockers.
- **Done when:**
  - `npm run check` passes
  - Tests: rows follow the configured order; the default icon is `comment`; an empty list gives no
    `Triggers` node; the header and PR nodes come first

## Out of scope

- CI changes, and secret scanning (the `gitleaks` hook was removed at the user's request).
- Multi-root repo picking, and showing `owner/repo @ branch` in the view description.
- Non-standard ports on GHE remotes.
- Fork workflows (recorded as out of scope in Step 2).
- Required approval count from branch protection (Future work in `.plan/zuul-vscode.md`).
- Project name casing, found in the Step 8 review and not verified against a live Zuul. `resolveTenant`
  now matches case-insensitively, but `ResolvedContext.project` keeps the git remote's casing and is
  sent as the builds filter (`src/services/prTracker.ts`). If the casing differs on a case-sensitive
  Zuul database, the view could show no builds where it used to report `no-tenant`. Fix later by having
  tenant resolution return Zuul's own project name.
