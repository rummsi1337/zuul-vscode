# API request efficiency — Implementation Plan

## Context

The extension polls GitHub Enterprise and Zuul. This plan checks five requirements against the code
and closes the gaps. Steps 1 and 2 are done, and the measurements and tables below describe the code
before those two steps. On 2026-11-08 the remaining steps were cut down to the changes that save real
requests. What was dropped, and why, is in Decisions and Out of scope.

### Measured today

Checked on 2026-11-08. The real `src/` classes ran against a fake server for one simulated hour, with
the window focused. "Sidebar open" means each view re-renders on every change event, as VS Code does
for a visible view. The fake server answers instantly, so real counts are the same or slightly lower.

| Scenario                                    | GitHub / h | Zuul / h | What the user gets                     |
| ------------------------------------------- | ---------: | -------: | -------------------------------------- |
| Idle PR, sidebar open                       |        382 |      244 | Works                                  |
| Build running, sidebar open                 |        727 |      362 | Works                                  |
| Build running, 2 `Depends-On`, sidebar open |      2,181 |    1,284 | Works                                  |
| Idle PR, sidebar closed                     |         77 |      122 | 61 of the 77 are searches for a hidden view |
| Branch has no PR                            |         61 |        0 | Polls forever                          |
| GitHub answers 500 to everything            |         61 |        0 | Polls forever                          |
| GitHub answers 429 with `Retry-After: 3600` |         61 |        0 | Ignores `Retry-After`, polls forever   |
| Zuul 401, tenant set in settings            |         16 |       61 | No PR, gate and dependencies are empty |
| Zuul 401, tenant auto-detected              |          0 |        1 | Nothing loads, not even GitHub data    |

Other measured costs:

- Idle PR, one hour: 626 SecretStorage reads and 764 `setContext` calls.
- No PAT and `gh` not logged in: one `gh auth token` process per GitHub request (69 in 10 minutes).
- One window focus change: 3 requests, or 11 when the gate and dependency caches have expired.
- A 304 response makes `HttpClient.request` throw `HttpError(304)`, because `res.ok` is false.

### The five requirements today

| #   | Requirement                 | Status | Evidence |
| --- | --------------------------- | ------ | -------- |
| 1   | Cache repeated fetches      | Partly | Cached: `gh` token on success (5 min), Zuul projects (5 min), tenant (workspaceState), gate report (30 s), dependencies (60 s). Not cached: PAT, failed `gh` lookups, Zuul tokens (keychain and token file on every request), required checks and merge rules (fetched on every gate refresh), and the Zuul calls that poll and gate both make moments apart. |
| 2   | GitHub best practices       | No     | See the next table. |
| 3   | Stop polling after failures | No     | `PrTracker.poll` always calls `scheduleNext` in `finally`. |
| 4   | Lower, configurable polling | No     | 3 s, 15 s and 60 s are constants in `pollSchedule.ts`. There is no setting. |
| 5   | Works without a Zuul token  | No     | Three causes, below. |

Why GitHub features die with Zuul (requirement 5):

- `ZuulContextService.recompute` sets `current` to `undefined` when tenant discovery fails.
- `PrTracker.poll` fetches Zuul inside the same `try` as GitHub, so a Zuul error means no snapshot.
  Gate, dependencies and trigger commands all need a snapshot. The views then wrongly say
  "No pull request found".
- `collectGateFacts` awaits Zuul inside one `Promise.all`, and `DependsOnService.getUpstream` calls
  `tenantProjects()` with no guard, so a Zuul error fails the whole view.

### GitHub best practices today

Source: GitHub's REST best-practices and rate-limit pages, API version 2026-03-10, read 2026-11-08.

| Practice                                | Today | Step |
| --------------------------------------- | ----- | ---- |
| Conditional requests (ETag, 304)        | Not used, and a 304 would throw | 1 |
| `retry-after`, `x-ratelimit-*`          | Ignored. Only a 403 whose body says "rate limit" is recognised, not 429 | 2 |
| Serial requests                         | Gate sends 5 at once, and again for each upstream PR. Left as it is, see Decisions | none |
| Authenticated requests                  | Sends requests with no token when none is found | 3 |
| Do not ignore repeated 4xx and 5xx      | Retries forever | 7 |
| Avoid polling, use webhooks             | Webhooks are impossible here (no inbound endpoint). Polling is reduced instead | 6, 7 |
| Follow redirects                        | OK, `fetch` follows them. `Authorization` is removed for other origins | none |
| Use `Link` headers for pagination       | OK, `fetchPages` | none |
| Pause between many mutating requests    | OK, only single user-started writes | none |
| `x-poll-interval`                       | Not applicable, only sent by endpoints this extension doesn't use | none |

### Facts the steps rely on

- 304 is free on the primary limit only when the request carries a valid `Authorization` header.
- GraphQL requests are POST, so they cannot use ETags. A query costs one point.
- GitHub allows 100 concurrent requests and 5,000 authenticated requests per hour. Search allows 30
  requests per minute.
- Rate limits are often off on GitHub Enterprise Server. The response headers are then absent and the
  guard in Step 2 stays idle.
- `ZuulClient.withAuth` tries each candidate token on a 401 or 403, so a refused call costs one
  request per candidate.
- `TreeView.message` exists in `@types/vscode` 1.101 (checked).
- **Assumed:** VS Code does not call `getChildren` for a hidden view. Step 8 checks this by hand.
- **Not verified:** whether Zuul answers 304. This plan uses time-based caching for Zuul only.

Already correct, keep it: polling pauses when the window is not focused, and stale poll results are
discarded with `sessionSeq` and `pollRunSeq`.

## Goal

An idle PR costs about 26 charged GitHub requests and 26 Zuul requests per hour instead of 382 and
244. Polling stops when retrying can't help, and says why. GitHub features keep working when Zuul or
its token doesn't.

Expected per hour at default settings. These are estimates from the calls each poll makes, not
measurements. Step 10 checks them.

| Scenario                    | GitHub charged | Zuul                    |
| --------------------------- | -------------: | ----------------------- |
| Idle PR, sidebar open       |            ~26 | ~26                     |
| Idle PR, sidebar closed     |             ~1 | ~24                     |
| Build running, sidebar open |           ~120 | ~60                     |
| Zuul refuses the token      |            ~26 | 1 per candidate token   |
| Zuul is down                |            ~26 | 4                       |

## Conventions

- Simplicity first. Only change an API call when that saves requests that aren't already a free 304.
  Don't add a cache, queue or retry for anything else.
- Acceptance command for every step: `npm run check`.
- No git state changes (commit, add, stash, checkout, branch, push).
- Every behaviour change gets a test in the same step. Find code by name, because line numbers move.
- Classes take `now`, timers and `fetchFn` as injected dependencies. Keep doing that.
- Never log tokens or put them in cache keys.
- Follow the existing style: small classes, `Pick<>` client interfaces, `HttpError` for HTTP failures.

## Decisions

Already made. Implementers must not change these.

| Topic | Decision |
| ----- | -------- |
| Polling setting | One setting, `zuul.pollIntervalSeconds`, default 60, range 10 to 3600. The user wants to try low values. |
| Intervals | Build running: the setting. Nothing running: 5 times the setting (5 min by default). After posting a trigger: every 15 s for 45 s (3 polls, was 15), or at the setting if that is lower. |
| Short reuse window | 5 s for Zuul `getChangeStatus` and `listBuilds`, which is below the 10 s minimum interval, so a poll never gets the previous poll's answer. |
| GitHub PR fetches | No time-based reuse. Step 1 already makes repeat GETs a free 304. |
| One request at a time | Not added. The gate sends 5 at once and GitHub allows 100. A queue saves no requests and slows the views. |
| Token caches | Not added. They save local keychain and file reads, not API calls, and Step 6 cuts those by about 80%. |
| View refresh | The gate keeps its 30 s limit and dependencies keep 60 s. A visible view reloads on a poll once its limit has passed. |
| Retries | GitHub and Zuul, counted separately. First try plus at most 3 retries, after 30, 60 and 120 s, then stop. |
| No retry | GitHub 401, 403 and 404, and Zuul 401 and 403, stop at once. Retrying the same credentials can't help. |
| Rate limits | Don't count as failures. Wait for the time GitHub gives, then resume by itself. |
| Zuul stopped | GitHub polling continues. A replaced token file needs Refresh once Zuul has stopped. While Zuul is failing, only the poll calls it. With no statuses the poll runs at the idle interval. |
| No PR on the branch | Stop polling. One lookup on window focus, at most once per poll interval. Confirmed by the user. |
| Zuul data gone | Gate can't say "Ready": the Zuul check row shows "unknown" and stays a blocker. |
| No GitHub token | Send nothing to GitHub. Show the existing "no token" text. |
| What degrades | Only Zuul auth and network problems. `no-zuul-url` and "repo is not in any tenant" still switch the extension off for that repo. Otherwise it would poll GitHub for every repo in every window. |

When polling resumes:

| Stopped because                 | Resumes on |
| ------------------------------- | ---------- |
| No PR                           | Refresh, branch or HEAD change, one lookup on focus |
| GitHub failing after retries    | Refresh, branch or HEAD change |
| GitHub 401, 403, 404, no token  | Refresh, PAT set or cleared, branch or HEAD change |
| GitHub rate limit               | By itself at the time GitHub gave |
| Zuul token refused (401, 403)   | Refresh, token set or cleared, branch or HEAD change. GitHub polling continues |
| Zuul failing after retries      | Refresh, branch or HEAD change. GitHub polling continues |
| Window unfocused                | Focus |

## Steps

### Step 1: Send conditional GET requests to GitHub

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/clients/http.ts`, `src/clients/gheClient.ts`, `test/unit/http.test.ts`,
  `test/unit/gheClient.test.ts` (edit)
- **Do:**
  - Add `conditionalGet?: boolean` to `HttpClientOptions`, default false. `GheClient` passes true.
  - In `HttpClient`, add a `Map` keyed by the URL from `resolveUrl`. Values are
    `{ etag?: string; lastModified?: string; data: unknown; headers: Headers }`. Cap it at 200 entries:
    move an entry to the end on use and drop the oldest.
  - Only `getJsonWithHeaders` uses the map. With a stored entry, send `If-None-Match`, or
    `If-Modified-Since` when there is only `last-modified`.
  - Give `request` an `allowNotModified` option so a 304 is returned instead of thrown. Return the
    stored `data` and stored `headers`.
  - Returning the stored `headers` keeps `fetchPages` walking `Link: rel="next"`. Each page must be
    revalidated on its own: a new review lands on the last page, so a 304 on page 1 proves nothing.
  - Store only 200 responses that have `etag` or `last-modified`.
  - Clear the map when the `Authorization` value differs from the previous GET.
  - `listReviews`: pass `{ per_page: PER_PAGE }`.
- **Don't:** use this for POST, GraphQL, `getText` or `getBytes`. Don't enable it for Zuul. Don't
  persist it to disk.
- **Done when:**
  - `npm run check` passes
  - Tests show: the second GET sends `If-None-Match`; a 304 returns the first body; a two-page list
    revalidates both pages; a token change drops stored entries; 200 entries is the limit

### Step 2: Respect GitHub rate limits

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/clients/rateLimit.ts` (new), `test/unit/rateLimit.test.ts` (new),
  `src/clients/http.ts`, `src/clients/gheClient.ts`, `src/util/commandErrors.ts`,
  `test/unit/http.test.ts`, `test/unit/gheClient.test.ts`, `test/unit/commandErrors.test.ts` (edit)
- **Do:**
  - Add `class RateLimitedError extends HttpError` with `retryAt: number`.
  - Add `class RateLimitGuard` with one block time per bucket: `core`, `search` (paths under
    `/search/`), `graphql`. It takes an injected `now`.
  - Add `rateLimit?: RateLimitGuard` to `HttpClientOptions`. Only `GheClient` passes one.
  - Before sending, if the bucket is blocked, throw `RateLimitedError` without touching the network.
  - After a 403 or 429, it is a rate limit when `retry-after` is present, or
    `x-ratelimit-remaining` is `0`, or the body matches `/rate limit/i`. Wait, in this order:
    1. `retry-after` seconds
    2. until `x-ratelimit-reset` (epoch seconds) when remaining is `0`
    3. otherwise 60 s, doubling on each hit in a row up to 15 min. A successful response resets this.
  - In `HttpClient.graphql`, a 200 with `errors[].type === 'RATE_LIMITED'` trips the `graphql` bucket
    and throws `RateLimitedError`.
  - `getRequiredContexts`, `getBranchMergeRules` and `getPrRollup`: rethrow `RateLimitedError`. Their
    fallbacks would otherwise send more requests while limited.
  - `commandErrors.ts`: `isRateLimitError` also accepts `RateLimitedError` and a 429. `shortReason`
    gives the time, e.g. `rate limit reached, try again at 14:32`. No Sign in button for these.
- **Don't:** slow down based on the remaining count. GitHub says not to depend on the exact number.
  Don't add this to Zuul.
- **Done when:**
  - `npm run check` passes
  - Tests cover each wait rule, 403 and 429, GraphQL `RATE_LIMITED`, no network while blocked, and no
    REST fallback from `getRequiredContexts` while limited

### Step 3: Send nothing to GitHub without a token

- **Tier:** sonnet
- **Risk:** low
- **Status:** done
- **Files:** `src/clients/http.ts`, `src/clients/gheClient.ts`, `test/unit/http.test.ts`,
  `test/unit/gheClient.test.ts` (edit)
- **Do:**
  - Add `requireAuth?: boolean` to `HttpClientOptions`. `GheClient` passes true.
  - When `getAuthHeader` returns nothing and `requireAuth` is set, throw
    `HttpError(401, 'No GitHub token available')` before any network call.
- **Don't:** cache tokens. Don't change `validatePatWithGhe`, which supplies its token.
- **Done when:**
  - `npm run check` passes
  - Tests show no GET or GraphQL request leaves without a token, and the error is a 401

### Step 4: Resolve the GitHub side without Zuul

- **Tier:** opus
- **Risk:** high
- **Status:** done
- **Files:** `src/context/zuulContext.ts`, `src/extension.ts`, `src/services/prTracker.ts`,
  `src/views/prGateTreeView.ts`, `src/views/dependsOnTreeView.ts`, `src/views/addDependsOnPick.ts`,
  `src/services/gateReadiness.ts`, `package.json`, `test/unit/zuulContext.test.ts`,
  `test/unit/viewsWelcome.test.ts`, and any test that builds a `ResolvedContext` (edit)
- **Do:**
  - Change the types:

    ```ts
    export type ContextProblem = 'no-repo' | 'no-zuul-url' | 'no-tenant';
    export type ZuulProblem = 'zuul-auth' | 'zuul-unreachable';
    export interface ZuulAccess { url: string; tenant: string; client: ZuulClient; }
    export interface ResolvedContext extends GitContext {
      project: string;
      ghe: GheClient;
      zuul?: ZuulAccess;
    }
    ```

  - `recompute`: when tenant discovery throws, publish the context without `zuul` and set
    `zuulProblem` (401 or 403 gives `zuul-auth`, anything else `zuul-unreachable`).
  - A successful discovery that finds no tenant stays `no-tenant`, with `current` undefined.
    `no-zuul-url` and `no-repo` also stay as they are.
  - Add a `zuulProblem` getter. `updateState` also fires when it changes. `isSameResolvedContext`
    compares `zuul?.url` and `zuul?.tenant`.
  - `resolveGateRules(rules, tenant: string | undefined)`: with no tenant, remove names containing
    `{tenant}`.
  - Fix every call site the compiler reports. Where Zuul is absent, use the behaviour from Step 5. For
    this step a plain `if (!rc.zuul)` that skips the Zuul call is enough.
  - `extension.ts`: set the context key `zuul.zuulProblem` to `zuulContext.zuulProblem ?? 'none'`.
  - `package.json` `viewsWelcome`: remove the `zuul-unreachable` entries for the gate and dependencies
    views. For the builds view, add entries on `zuul.zuulProblem`: `zuul-auth` links to
    `command:zuul.setTenantToken`, `zuul-unreachable` links to `command:zuul.refresh`.
- **Don't:** change the `no-zuul-url` or `no-tenant` behaviour.
- **Done when:**
  - `npm run check` passes
  - A test shows a 401 during tenant discovery gives a `current` with `ghe` and no `zuul`

### Step 5: Keep GitHub features working when Zuul fails

- **Tier:** sonnet
- **Risk:** high
- **Status:** todo
- **Files:** `src/services/prTracker.ts`, `src/services/gateFacts.ts`,
  `src/services/gateReadiness.ts`, `src/services/dependsOnService.ts`,
  `src/views/addDependsOnPick.ts`, `src/views/prGateTreeView.ts`, `src/views/dependsOnTreeView.ts`,
  `src/services/triggerService.ts`, and their tests (edit)
- **Do:**
  - Add to `PrSnapshot`:

    ```ts
    zuul:
      | { kind: 'ok' }
      | { kind: 'unavailable'; reason: 'needs-token' | 'no-access' | 'unreachable'; message: string };
    ```

  - `PrTracker.poll`: put GitHub and Zuul in separate `try` blocks. A Zuul error no longer sets the
    poll error and no longer prevents a snapshot. It sets `zuul` to `unavailable` with empty statuses
    and builds. 401 gives `needs-token`, 403 `no-access`, anything else `unreachable`. With no
    `rc.zuul`, skip Zuul and map `zuulProblem` the same way.
  - `gateFacts.ts`: `zuul` and `tenant` become optional. Catch errors from `resolveZuulCheckState` and
    return a new `ZuulCheckState` value, `'unknown'`. Don't call Zuul when it is absent.
  - `collectUpstreamFacts`: a Zuul failure must no longer produce "Could not read this pull request".
  - `gateReadiness.ts`: `'unknown'` adds the row `Zuul check` with ok false and message
    `Zuul check can't be read`, and stays a `zuul-check` blocker.
  - `DependsOnService`: `zuul` and `tenant` become optional. Guard `tenantProjects()`. When projects
    can't be read, treat every repo as in the tenant, add no tenant warning, and skip Zuul status.
  - `addDependsOnPick.ts`: when `listProjects` fails or Zuul is absent, skip the tenant filter and the
    "is not part of tenant" refusal, and log a warning. Today the refusal is false in that case.
  - `TriggerService.post`: still post the comment. When `snapshot.zuul.kind` isn't `ok`, skip the watch
    and don't show "waiting for enqueue".
  - The gate and dependency views: when `snapshot.zuul.kind` isn't `ok`, pass no Zuul client, so only
    the poll talks to a failing Zuul.
- **Don't:** keep old Zuul data after a failure. Don't change how the gate rows are ordered.
- **Done when:**
  - `npm run check` passes
  - Tests show that with every Zuul call returning 401: a snapshot exists, the gate shows GitHub rows
    and is not ready, dependencies list both groups, a trigger comment can be posted, and the gate and
    dependency views send no Zuul requests

### Step 6: Lower polling and make it configurable

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `src/services/pollSchedule.ts`, `src/services/prTracker.ts`, `src/config/settings.ts`,
  `src/extension.ts`, `package.json`, `test/unit/pollSchedule.test.ts`,
  `test/unit/prTracker.test.ts`, `test/unit/settings.test.ts` (edit)
- **Do:**
  - `package.json`: add `zuul.pollIntervalSeconds` (number, default 60, minimum 10, maximum 3600). The
    description says when nothing is running the extension checks 5 times less often, and that lower
    values use more API requests.
  - `settings.ts`: add `pollIntervalSeconds`, clamped to 10..3600, falling back to 60 if not a number.
  - `pollSchedule.ts`: `nextPollDelayMs(snapshot, intervalMs, fastUntil, now)`. Use
    `Math.min(15_000, intervalMs)` while `now < fastUntil`, so posting a trigger never slows polling
    down. Use `intervalMs` when any status is `live`. Otherwise use `intervalMs * 5`.
  - `PrTracker`: add a constructor parameter `getPollIntervalMs: () => number`. `extension.ts` passes
    the setting.
  - Remove `PR_REFETCH_INTERVAL_TICKS` and `pollCount`. The PR lookup runs on every tick, since an
    unchanged answer is a free 304.
  - `handleFocusChange(true)`: don't force a poll. Poll only if the last poll is older than the current
    delay, otherwise schedule the remainder.
- **Don't:** add separate settings for GitHub and Zuul. Don't add an inactivity pause.
- **Done when:**
  - `npm run check` passes
  - Tests cover the three delays, the trigger delay when the setting is under 15 s, clamping to
    10..3600, and the throttled focus poll

### Step 7: Stop polling when retrying can't help

- **Tier:** opus
- **Risk:** high
- **Status:** todo
- **Files:** `src/services/prTracker.ts`, `src/services/pollSchedule.ts`, `src/views/statusBar.ts`,
  `src/extension.ts`, `README.md`, `test/unit/prTracker.test.ts` (edit)
- **Do:**
  - Replace `_pollError` and `onDidChangePollError` with:

    ```ts
    export type PollStatus =
      | { kind: 'active' }
      | { kind: 'no-pr' }
      | { kind: 'rate-limited'; until: number; message: string }
      | { kind: 'stopped'; reason: 'auth' | 'failed'; message: string; at: number; lastSuccessAt?: number };
    ```

    with `pollStatus` and `onDidChangePollStatus`. Update `statusBar.ts` so it still compiles.
  - GitHub errors in `poll`:
    - `RateLimitedError`: `rate-limited`, keep the snapshot, one timer at `retryAt`.
    - `HttpError` 401, 403 or 404: `stopped` with `auth`, no timer.
    - Anything else: count it. Retry after 30, 60 and 120 s. The fourth failure in a row is `stopped`
      with `failed`. Keep the last snapshot.
  - Add `RETRY_DELAYS_MS = [30_000, 60_000, 120_000]` to `pollSchedule.ts`.
  - No PR found: `no-pr`, no timer.
  - Zuul errors follow the same rules, with their own counter:
    - 401 or 403: stop Zuul at once.
    - Anything else: count it. The next poll runs after 30, 60 or 120 s. The fourth failure in a row
      stops Zuul. A Zuul success resets the counter.
  - To stop Zuul, keep the `unavailable` result in one field. While it is set, `poll` skips Zuul and
    reuses it. GitHub polling carries on at its normal interval.
  - Add `stopped: boolean` to the `unavailable` variant of `PrSnapshot.zuul`. It is true once Zuul is
    stopped, and also when `rc.zuul` is absent. Step 9 shows it.
  - `refresh()` and `handleContextChange` reset both counters, clear that field and set `active`.
  - `handleFocusChange(true)`: do nothing while `stopped`. While `rate-limited`, restore the timer.
    While `no-pr`, do one lookup if the last one is older than the poll interval.
  - `zuul.setGhePat` and `zuul.clearGhePat` already run `zuul.refresh`. Make `zuul.setTenantToken` and
    `zuul.clearTenantToken` run it too, so a new token applies at once.
  - `README.md`: after "Files are read on every request, so replacing a file takes effect right away."
    add "If Zuul has already refused the old token, run **Zuul: Refresh**."
- **Don't:** let focus restart a stopped poll or clear the Zuul field. Step 6 removed `refresh()` from
  the focus path, so keep it out. Don't show popups.
- **Done when:**
  - `npm run check` passes
  - Tests show: 500s make exactly 4 calls, then none for an hour; a 401 makes 1 call; `Retry-After: 3600`
    makes no call for an hour and then resumes; no PR makes 1 call; Refresh and a branch change resume;
    a Zuul 401 makes 1 call per token, then none for an hour, and GitHub keeps polling; Zuul 500s make
    exactly 4 Zuul calls, then none for an hour, and GitHub keeps polling; Refresh and a new token try
    Zuul again

### Step 8: Cache branch rules, reuse Zuul answers, stop hidden-view requests

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `src/util/ttlCache.ts` (new), `test/unit/ttlCache.test.ts` (new),
  `src/clients/gheClient.ts`, `src/clients/zuulClient.ts`, `src/context/zuulContext.ts`,
  `src/views/dependsOnTreeView.ts`, `src/extension.ts`, and their tests (edit)
- **Do:**
  - Move `ZuulClient.cached` into `class TtlCache` with `get<T>(key, ttlMs, load)` and `clear()`. It
    takes an injected `now`. A failed load is not stored. `undefined` is a valid stored value.
  - `GheClient`: cache `getRequiredContexts` and `getBranchMergeRules` for 1 hour per repo and branch.
    Store "this branch has no rule", but never a failed request. `getBranchMergeRules` turns every
    failure into `undefined` today, so put only the query inside the cached load and keep that `catch`
    outside it. Otherwise one network blip hides a merge rule for an hour.
  - Add `GheClient.clearCache()`.
  - `ZuulClient`: `getChangeStatus` and `listBuilds` reuse their answer for 5 s, so the gate and
    dependencies reuse the poll's result from the same tick. Other cached calls keep their 5 min.
  - Lower-case the project in the `listBuilds` key. The poll uses the owner and repo from the git
    remote and the gate uses GitHub's, which can differ in case.
  - Add `ZuulContextService.clearClientCaches()`, which clears the current `ghe` and `zuul` clients.
    `zuul.refresh` calls it first. Today `clearCache` is never called.
  - `DependsOnTreeDataProvider.handleSnapshotChange`: remove the eager `ensureDataLoaded` call, so a
    hidden view fetches nothing. `getChildren` already loads.
- **Don't:** cache anything used to build a PR body edit. Don't show an older gate report after a
  failure, as the code comment in `getReport` already says. Don't cache `getPr`, `getPrRollup` or
  `searchPrs`.
- **Done when:**
  - `npm run check` passes
  - Tests show: one rules query per hour; a failed rules query is not stored; poll and gate share one
    `getChangeStatus` and one `listBuilds`; Refresh clears the caches; no `search/issues` without
    `getChildren`
  - Checked by hand in the Extension Development Host: with the Zuul sidebar closed, the Zuul output
    channel shows no gate or search requests

### Step 9: Tell the user what is happening

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/views/statusBar.ts`, `src/services/statusBarText.ts`, `src/extension.ts`,
  `package.json`, `test/unit/statusBarText.test.ts`, `test/unit/viewsWelcome.test.ts` (edit)
- **Do:**
  - Status bar text, with a click action:

    | State | Text | Click |
    | ----- | ---- | ----- |
    | `stopped`, `failed` | `$(warning) Zuul: GitHub not responding, updates stopped` | `zuul.refresh` |
    | `stopped`, `auth` | `$(warning) Zuul: GitHub sign-in needed, updates stopped` | `zuul.setGhePat` |
    | `rate-limited` | `$(clock) Zuul: GitHub rate limit, resumes HH:MM` | none |
    | `snapshot.zuul.reason` is `needs-token` or `no-access` | Normal PR text plus `, Zuul updates stopped (token needed)` | `zuul.setTenantToken` |
    | `snapshot.zuul.reason` is `unreachable`, `stopped` true | Normal PR text plus `, Zuul updates stopped (not responding)` | `zuul.refresh` |
    | `snapshot.zuul.reason` is `unreachable`, `stopped` false | Normal PR text plus `, Zuul retrying` | `zuul.refresh` |

  - The tooltip carries the full reason and says whether updates have stopped.
  - Show the same state at the top of all three sidebar views with `TreeView.message`, so old data
    can't be mistaken for live data. Switch `extension.ts` from `registerTreeDataProvider` to
    `createTreeView`. Get the text from one tested function in `statusBarText.ts`, and clear it on
    resume:
    - GitHub `failed`: "Updates stopped: GitHub is not responding. Data shown may be out of date. Use
      Refresh to try again."
    - GitHub `auth`: "Updates stopped: GitHub sign-in needed."
    - `rate-limited`: "Updates paused: GitHub rate limit, resumes at HH:MM."
    - Zuul stopped, not responding: "Zuul updates stopped: Zuul is not responding. GitHub data is
      still updating. Use Refresh to try again."
    - Zuul stopped, token: "Zuul updates stopped: the Zuul token was refused. GitHub data is still
      updating."
  - `extension.ts`: set the context key `zuul.pollState` to `active`, `no-pr`, `failed`, `auth` or
    `rate-limited`.
  - `viewsWelcome`: the "No pull request found for the current branch." entries also need
    `zuul.pollState == 'no-pr'`. Add one entry per view for `failed`, `auth` and `rate-limited`:
    "Could not load data from GitHub. [Retry](command:zuul.refresh)".
- **Don't:** add popups. Don't remove the existing Zuul token popup.
- **Done when:**
  - `npm run check` passes
  - A test shows "No pull request found" is not shown after a failed load
  - Tests show the status bar text and sidebar message for each state name the service that stopped,
    and that the sidebar message clears on resume

### Step 10: Lock in a request budget

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `test/unit/requestBudget.test.ts` (new)
- **Do:**
  - Build the real objects with a fake `fetchFn`: `AuthService`, `ZuulTokenProvider`,
    `ZuulContextService`, `PrTracker`, `PrGateTreeDataProvider`, `DependsOnTreeDataProvider`.
  - Mimic a visible view by calling `getChildren()` on every `onDidChangeTreeData`.
  - Use `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })`. Advance one second at
    a time, and after each second await `setImmediate` from `node:timers/promises` a few times.
  - The fake answers 304 when `If-None-Match` matches. "Charged" means any response that isn't a 304.
  - Assert these limits over one simulated hour, at the default interval of 60 s:

    | Scenario                    | GitHub charged | Zuul  |
    | --------------------------- | -------------: | ----: |
    | Idle PR, sidebar open       |           ≤ 40 |  ≤ 30 |
    | Build running, sidebar open |          ≤ 140 |  ≤ 75 |
    | Idle PR, sidebar closed     |            ≤ 3 |  ≤ 30 |

- **Don't:** loosen a limit to make the test pass without finding out why it is exceeded. Don't add
  the failure scenarios here, Step 7 already tests them.
- **Done when:**
  - `npm run check` passes, including this test

## Out of scope

- Webhooks. A VS Code extension has no endpoint to receive them.
- The "renew Zuul token" button from `future-work.md`.
- The redundant "Zuul check" row, and reading real review-thread and signature state (`future-work.md`).
- ETags for Zuul, until someone confirms a real Zuul server answers 304.
- Saving ETags across VS Code restarts.
- Removing unused `ZuulClient` methods (`getInfo`, `getProjectKey`, `getJob`, `listJobs`,
  `listNodesets`, `listProjectTemplates`, `listSemaphores`). They send no requests today.

Cut on 2026-11-08, because they save few or no real requests:

- A one-at-a-time queue for GitHub requests.
- A 5 s reuse window for `getPr`. Repeats are already a free 304.
- GitHub and Zuul token caches, JWT expiry checks, and comparing token lists to spot a new Zuul token.
- The 15-minute inactivity pause.
- Smarter view refresh: a Zuul fingerprint in the gate's cache key, `onDidPoll`, firing `onDidChange`
  only on a real change, and failure memory in `KeyedAsyncCache`.
- A 15-minute cache for dependency searches, and a 1-hour cache for Zuul tenants and projects.
- Popups and Builds-view rows for stopped polling, and a README section on polling.
