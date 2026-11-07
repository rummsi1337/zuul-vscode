# Zuul CI for VS Code (`zuul-vscode`) — Implementation Plan

## Context

- Source: this plan rewrites `IMPLEMENTATION_PLAN.md` (repo root) into self-contained steps. That
  file stays as the product vision (architecture diagram, feature descriptions). Implementers do
  **not** need to read it; everything required is in this file.
- Repo state (checked 2026-11-07): `git init` done, branch `main`, **no commits**, only
  `IMPLEMENTATION_PLAN.md`. Greenfield.
- Local toolchain (checked 2026-11-07): Node `v26.13.0`, npm `11.20.0`, VS Code `1.145.2`,
  `pre-commit` installed, `gh` CLI **not** installed (code must handle its absence).
- Target users: teams running Zuul CI with GitHub Enterprise (GHE). github.com must also work.

### Deliberate deviations from `IMPLEMENTATION_PLAN.md`

1. **Needed-By (downstream PRs)** comes from a GHE search for open PRs whose body contains this
   PR's URL, not from Zuul. Zuul's status API has no `needed_by` field.
2. **"Zuul sees these dependencies"** = the non-live items queued ahead of the change in the same
   Zuul queue entry (Zuul enqueues `Depends-On` targets as non-live items). There is no
   `dependencies` field in Zuul's status API.
3. **`org/repo#123` shorthand**: parsed and shown, but flagged "Zuul ignores this form". Zuul's
   GitHub driver only resolves full URLs. The extension always writes full URLs.
4. **GHE OAuth Path B**: Device Flow only. Authorization Code + PKCE is out of scope.
5. **Zuul auth**: paste a Zuul bearer token (SecretStorage) instead of a full OIDC browser flow.
6. **Whitelabeled Zuul tenants** (API without `/api/tenant/{t}`) are out of scope.

## Goal

A packaged VS Code extension (`npm run package` → `.vsix`) that shows Zuul status for the current
PR, posts trigger comments, manages `Depends-On`, explains gate blockers, inspects build logs
in-editor, and provides `.zuul.yaml` authoring help, with OAuth as default GHE login.

## Conventions

- **Working directory:** `/Users/simon/workspace/zuul-vscode`. All file paths and commands below are
  relative to this root.
- **Acceptance command for every step:** `npm run check`
  (= `lint` + `typecheck` + `test` with coverage + `build`; defined in Step 1). Plus the step's
  own **Done when** items.
- **Install all npm packages once in Step 1** so Steps 2–32 run completely offline inside the
  sandbox without network prompts. Pin added deps with `^` ranges as npm writes them.
- **No git state changes** (no commit, add, stash, checkout, branch, push). Leave changes in the
  working tree.
- **Language & style:** TypeScript `strict`, ES2022, CommonJS output bundled by esbuild to
  `dist/extension.js`. Prettier (`printWidth: 100`, `singleQuote: true`, `trailingComma: all`).
  ESLint flat config with `typescript-eslint` recommended.
- **Testability rule:** logic lives in modules that do **not** import `vscode` (parsers,
  evaluators, clients, services). Only `src/extension.ts`, `src/views/**`, `src/language/*Provider.ts`
  and thin adapters import `vscode`. Tests that need `vscode` use the alias mock
  `test/mocks/vscode.ts` (extend it as needed; never import the real module in unit tests).
- **Dependency injection:** clients and services receive collaborators via constructor
  (`fetchFn`, `getToken`, `execFile`, clock `now()`), so tests pass fakes. No module-level
  singletons except in `src/extension.ts`.
- **HTTP:** global `fetch` only (no axios/got). 15 s timeout via `AbortSignal.timeout(15000)`.
  Corporate CAs are handled by VS Code's proxy support and `NODE_EXTRA_CA_CERTS`; no custom TLS code.
- **WebSocket:** global `WebSocket` (Node 22+). No `ws` dependency.
- **Allowed runtime deps:** `yaml` (eemeli/yaml), `picomatch`. Anything else → report `BLOCKED`.
- **Tests:** vitest, files in `test/unit/<module>.test.ts`; fixtures in `test/fixtures/`.
  Every new module gets tests. Coverage threshold 80 % lines/branches on `src/**` excluding
  `src/extension.ts` and `src/views/**`.
- **Logging:** one `OutputChannel` named `Zuul` (created in `extension.ts`, passed as a
  `Logger { info, warn, error }` interface). Prefix messages with tags: `[Auth]`, `[GHE]`,
  `[Zuul]`, `[Poll]`, `[DependsOn]`, `[Gate]`, `[Logs]`, `[YAML]`. Never log tokens.
- **Errors to users:** `vscode.window.showErrorMessage` with a short human message; HTTP 401/403
  → offer "Sign in" action that runs `zuul.signIn` (until Step 31 that command is `zuul.setGhePat`).
- **Commands** are added to `package.json` `contributes.commands` in the step that implements
  them, with `"category": "Zuul"`. IDs listed per step are final.
- **Ids that never change:** view container `zuul-explorer`; views `zuul.gateReadiness`,
  `zuul.dependencies`, `zuul.builds`; output channel `Zuul`; publisher `zuul-vscode-dev`
  (placeholder until the user picks one); extension name `zuul-vscode`.

## Testing Checkpoints

Good points to build, install, and manually test the extension:

| Checkpoint | After Step | What works |
|---|---|---|
| **1 — PR Status & Dependencies** | Step 14 | PAT / `gh` CLI auth, tenant auto-discovery, status bar, **Builds** tree, trigger comments (`recheck`), and **Dependencies** (`Depends-On` / `Needed-By`). **Gate Readiness** is still blank. |
| **2 — Full Sidebar (recommended first install)** | Step 17 | All 3 sidebar views live: adds **Gate Readiness** checklist and blocker explanations across the PR and its upstream `Depends-On` chain. |
| **3 — In-Editor Log Inspection** | Step 21 | Failed Ansible task view, pinned artifacts, full log manifest browser, clickable stack traces (`File "...", line N` / `path:line`), and live WebSocket console streaming. |
| **4 — `.zuul.yaml` Authoring** | Step 28 | JSON schema validation, autocomplete, hover, go-to-definition, effective job preview CodeLens, `files` / `irrelevant-files` diff simulator, and RSA-OAEP secret encryption. |
| **5 — OAuth Sign-In** | Step 31 | One-click GitHub Enterprise OAuth login (VS Code built-in provider + OAuth Device Flow) as the default auth method. |

**How to test at any checkpoint:**
- **Extension Development Host (no install):** open this repo in VS Code and press `F5`.
- **Package & install `.vsix`:** `npm run package && code --install-extension zuul-vscode-0.0.1.vsix`, then set `zuul.url` in VS Code settings and run `Zuul: Set GitHub Enterprise PAT` (or `Zuul: Sign In` from Step 29+).

## Steps

### Step 1: Scaffold the TypeScript extension toolchain

- **Tier:** sonnet
- **Risk:** low
- **Status:** done
- **Files:** `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`,
  `eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `.gitignore`, `.vscodeignore`,
  `.pre-commit-config.yaml`, `src/extension.ts`, `src/util/logger.ts`, `test/mocks/vscode.ts`,
  `test/unit/logger.test.ts`, `.vscode/launch.json`, `.vscode/tasks.json` (all new)
- **Do:**
  - `package.json`: `name: zuul-vscode`, `displayName: "Zuul CI"`, `publisher: zuul-vscode-dev`,
    `version: 0.0.1`, `engines.vscode: ^1.100.0`, `main: ./dist/extension.js`,
    `activationEvents: []` (filled in Step 2), `license: "UNLICENSED"`, `private: true`.
  - dependencies: `yaml`, `picomatch` (installed now so later steps never need `npm install`).
  - devDependencies: `typescript`, `esbuild`, `vitest`, `@vitest/coverage-v8`, `@types/vscode@~1.100.0`,
    `@types/node@^22`, `@types/picomatch`, `eslint`, `typescript-eslint`, `prettier`, `@vscode/vsce`,
    `@vscode/test-cli`, `@vscode/test-electron`, `mocha`, `@types/mocha`.
  - Scripts: `build` (`node esbuild.mjs --production`), `watch` (`node esbuild.mjs --watch`),
    `typecheck` (`tsc --noEmit`), `lint` (`eslint . && prettier --check .`),
    `format` (`prettier --write .`), `test` (`vitest run --coverage`),
    `check` (`npm run lint && npm run typecheck && npm test && npm run build`),
    `package` (`vsce package --no-dependencies`).
  - `esbuild.mjs`: entry `src/extension.ts`, `bundle`, `platform: node`, `format: cjs`,
    `target: node20`, `external: ['vscode']`, `outfile: dist/extension.js`, sourcemap unless
    `--production`, minify with `--production`, `--watch` support.
  - `tsconfig.json`: `strict`, `target ES2022`, `module commonjs`, `lib ["ES2022", "DOM"]`
    (DOM for `fetch`/`WebSocket` types), `types ["node", "vscode"]`, include `src`, `test`,
    `noEmit`.
  - `vitest.config.ts`: `resolve.alias: { vscode: path.resolve('test/mocks/vscode.ts') }`,
    `test.include: ['test/unit/**/*.test.ts']`, coverage provider v8, include `src/**`, exclude
    `src/extension.ts`, `src/views/**`, thresholds `lines: 80, branches: 80`.
  - `src/util/logger.ts`: `interface Logger { info(m: string): void; warn(...); error(m: string, err?: unknown): void }`
    and `createOutputLogger(channel: { appendLine(s: string): void }): Logger` that prefixes ISO
    time and level. Test it with a fake channel.
  - `src/extension.ts`: `activate(context)` creates `vscode.window.createOutputChannel('Zuul')`,
    logger, logs `[Zuul] activated`; `deactivate()` no-op.
  - `test/mocks/vscode.ts`: minimal mock exporting `window`, `workspace`, `commands`, `Uri`,
    `EventEmitter`, `TreeItem`, `TreeItemCollapsibleState`, `ThemeIcon`, `StatusBarAlignment`,
    `Disposable` as plain classes/objects with `vi.fn()`; extended in later steps.
  - `.pre-commit-config.yaml`: one `local` repo with hooks `lint` (`npm run lint`),
    `typecheck` (`npm run typecheck`), `language: system`, `pass_filenames: false`.
  - `.gitignore`: `node_modules/`, `dist/`, `coverage/`, `*.vsix`, `.vscode-test/`.
  - `.vscodeignore`: exclude `src/`, `test/`, `coverage/`, `.plan/`, configs, maps.
  - `.vscode/launch.json`: "Run Extension" (`extensionHost`, preLaunchTask `npm: watch`).
- **Don't:** add any feature code, views or commands. Don't add webpack.
- **Done when:**
  - `npm install && npm run check` passes
  - `dist/extension.js` exists and does not contain the `vscode` module source

### Step 2: Declare manifest contributions and a typed settings reader

- **Tier:** sonnet
- **Risk:** low
- **Status:** done
- **Files:** `package.json` (edit), `resources/icons/zuul.svg` (new), `src/config/settings.ts` (new),
  `test/unit/settings.test.ts` (new), `test/mocks/vscode.ts` (edit)
- **Do:**
  - `activationEvents`: `workspaceContains:.zuul.yaml`, `workspaceContains:zuul.yaml`,
    `workspaceContains:zuul.d/**`, `workspaceContains:.zuul.d/**`, `onStartupFinished`.
  - `contributes.viewsContainers.activitybar`: `{ id: 'zuul-explorer', title: 'Zuul', icon: 'resources/icons/zuul.svg' }`.
    Icon: simple monochrome 24×24 SVG (a stylised "Z"), `currentColor` fill.
  - `contributes.views['zuul-explorer']`: `zuul.gateReadiness` ("Gate Readiness"),
    `zuul.dependencies` ("Dependencies"), `zuul.builds` ("Builds").
  - `contributes.viewsWelcome` for `zuul.gateReadiness`: text "No pull request found for the
    current branch." (static text; no command link yet).
  - `contributes.configuration` (title "Zuul"), exactly these settings:

    | Key | Type | Default | Notes |
    |---|---|---|---|
    | `zuul.url` | string | `""` | Base URL of Zuul Web, e.g. `https://zuul.example.com` |
    | `zuul.tenant` | string | `""` | Auto-detected if empty |
    | `zuul.ghe.host` | string | `""` | Auto-detected from git remote if empty |
    | `zuul.auth.method` | enum `auto`,`oauth`,`gh-cli`,`pat` | `"pat"` | Changed to `auto` in Step 31 |
    | `zuul.ghe.oauthClientId` | string | `""` | OAuth App client ID for Device Flow |
    | `zuul.triggerComments` | array of `{label: string, comment: string, icon?: string}` | `[{"label":"Recheck","comment":"recheck","icon":"refresh"}]` | |
    | `zuul.pinnedArtifacts` | array of string | `["job-output.txt"]` | Glob patterns |
    | `zuul.gate.requiredApprovals` | number | `1` | Fallback when not auto-detected |
    | `zuul.gate.requiredStatusChecks` | object (string → string[]) | `{}` | Keys `*` or `org/repo` |
    | `zuul.gate.requiredLabels` | array of string | `[]` | |
    | `zuul.gate.blockingLabels` | array of string | `["do-not-merge","wip"]` | |

    Give every setting a `markdownDescription`; `zuul.triggerComments` gets a full JSON schema
    for its items (`required: ["label","comment"]`).
  - `src/config/settings.ts`: `interface ZuulSettings` mirroring the table (camelCase:
    `url, tenant, gheHost, authMethod, oauthClientId, triggerComments, pinnedArtifacts,
    gate: { requiredApprovals, requiredStatusChecks, requiredLabels, blockingLabels }`).
    `readSettings(get: (key: string) => unknown): ZuulSettings` — pure, validates types, falls
    back to defaults on wrong types, strips a trailing `/` from `url`. Plus
    `readWorkspaceSettings()` adapter using `vscode.workspace.getConfiguration('zuul')`, and
    `onSettingsChanged(cb)` using `workspace.onDidChangeConfiguration(e => e.affectsConfiguration('zuul'))`.
- **Don't:** register tree data providers yet (empty views are fine). Don't add commands.
- **Done when:**
  - `npm run check` passes
  - Tests cover defaults, wrong-type fallback and trailing-slash stripping

### Step 3: Detect git context (host, owner, repo, branch, HEAD)

- **Tier:** sonnet
- **Risk:** low
- **Status:** done
- **Files:** `src/git/remoteUrl.ts` (new), `src/git/gitApi.ts` (new), `src/git/gitContext.ts` (new),
  `test/unit/remoteUrl.test.ts` (new), `test/unit/gitContext.test.ts` (new)
- **Do:**
  - `remoteUrl.ts`: `parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | undefined`.
    Supports `git@host:owner/repo(.git)`, `ssh://git@host(:port)/owner/repo(.git)`,
    `https://(user@)host(:port)/owner/repo(.git)(/)`. Host is lowercase without port. Returns
    `undefined` for anything else.
  - `gitApi.ts`: minimal hand-written types for the built-in `vscode.git` API v1 — only
    `API { repositories: Repository[]; onDidOpenRepository; onDidCloseRepository }`,
    `Repository { rootUri; state: { HEAD?: { name?: string; commit?: string }; remotes: { name: string; fetchUrl?: string; pushUrl?: string }[]; onDidChange: Event<void> } }`.
    `getGitApi(): Promise<API | undefined>` activates `vscode.git` and calls `exports.getAPI(1)`.
  - `gitContext.ts`: `interface GitContext { repoRoot: string; host: string; owner: string; repo: string; branch?: string; headSha?: string }`.
    Pure `computeGitContext(repo: RepoLike, hostOverride?: string): GitContext | undefined`:
    pick remote `origin`, else the first remote; use `fetchUrl ?? pushUrl`; if `hostOverride`
    (setting `zuul.ghe.host`) is set, use it as host. Class `GitContextService` (vscode adapter):
    uses the repository containing the first workspace folder (else the first repository),
    exposes `current: GitContext | undefined` and `onDidChange: Event<GitContext | undefined>`
    fired only when a field changes (debounce 300 ms).
  - Wire `GitContextService` in `extension.ts`; log `[Git] context: host/owner/repo@branch`.
- **Don't:** shell out to `git` here. Don't resolve tenants or PRs.
- **Done when:**
  - `npm run check` passes
  - Tests cover all URL forms, `.git` suffix, ports, invalid URLs, origin preference, host override

### Step 4: Add the HTTP base and the GitHub Enterprise client

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/clients/http.ts` (new), `src/clients/gheClient.ts` (new), `src/clients/gheTypes.ts` (new),
  `test/unit/http.test.ts` (new), `test/unit/gheClient.test.ts` (new), `test/fixtures/ghe/*.json` (new)
- **Do:**
  - `http.ts`: `class HttpError extends Error { status: number; body: string }`.
    `class HttpClient { constructor(opts: { baseUrl: string; getAuthHeader?: () => Promise<string | undefined>; fetchFn?: typeof fetch; userAgent?: string }) }`
    with `getJson<T>(path, query?)`, `postJson<T>(path, body)`, `patchJson<T>(path, body)`,
    `graphql<T>(url, query, variables)`, `getBytes(absoluteUrl): Promise<Uint8Array>`,
    `getText(absoluteUrl)`. `path` starting with `http` is used as-is. 15 s timeout. Non-2xx →
    `HttpError`. `getBytes`/`getText` gunzip (node `zlib.gunzipSync`) when the bytes start
    with `0x1f 0x8b`. Header `User-Agent: zuul-vscode`.
  - `gheClient.ts`: constructor `(host: string, getToken: () => Promise<string | undefined>, fetchFn?)`.
    REST base `https://<host>/api/v3`, GraphQL `https://<host>/api/graphql`; when host is
    `github.com` use `https://api.github.com` and `https://api.github.com/graphql`. Auth header
    `Authorization: Bearer <token>`. Methods (names final):
    - `getUser()` → `GET /user`
    - `findOpenPrForBranch(owner, repo, branch)` → `GET /repos/{o}/{r}/pulls?state=open&head={owner}:{branch}`, first or `undefined`
    - `getPr(owner, repo, num)`, `updatePrBody(owner, repo, num, body)` (`PATCH .../pulls/{n}`)
    - `listReviews(owner, repo, num)` (all pages)
    - `listCommitStatuses(owner, repo, sha)` → `GET .../commits/{sha}/status` (combined)
    - `listCheckRuns(owner, repo, sha)` → `GET .../commits/{sha}/check-runs`
    - `getRequiredStatusChecks(owner, repo, branch)` → `GET .../branches/{b}/protection/required_status_checks`; 403/404 → `undefined`
    - `getPrRollup(owner, repo, num)` → GraphQL: `pullRequest { id isDraft mergeable reviewDecision labels(first:50){nodes{name}} commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){nodes{__typename ... on StatusContext{context state isRequired(pullRequestNumber:$num)} ... on CheckRun{name conclusion status isRequired(pullRequestNumber:$num)}}}}}}} }`; GraphQL errors → `undefined` (caller falls back to REST)
    - `postIssueComment(owner, repo, num, body)`
    - `searchPrs(query: string, perPage = 20)` → `GET /search/issues?q=...+is:pr`
    - Pagination helper follows the `Link: rel="next"` header, max 10 pages.
  - `gheTypes.ts`: only the fields used (`PullRequest { number, html_url, title, state, draft, merged, mergeable_state, body, head: {sha, ref, repo: {full_name}}, base: {ref, repo: {full_name}}, user: {login}, labels: {name}[] }`, `Review`, `CombinedStatus`, `CheckRun`, `PrRollup`, `SearchItem`).
  - Tests use a fake `fetchFn` with JSON fixtures; cover pagination, github.com URLs, 404 →
    `HttpError`, gzip handling, GraphQL error fallback.
- **Don't:** implement auth here (only call `getToken`). No caching.
- **Done when:**
  - `npm run check` passes

### Step 5: Add the Zuul REST client with a normalised status model

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/clients/zuulClient.ts` (new), `src/clients/zuulTypes.ts` (new),
  `test/unit/zuulClient.test.ts` (new), `test/fixtures/zuul/*.json` (new)
- **Do:**
  - Constructor `(baseUrl: string, getToken?: () => Promise<string | undefined>, fetchFn?, now = Date.now)`,
    built on `HttpClient`. All tenant calls under `/api/tenant/{tenant}`.
  - Methods (final names): `listTenants()` (`/api/tenants`), `listProjects(t)`, `getChangeStatus(t, pr, sha)`
    (`/status/change/{pr},{sha}`), `listBuilds(t, { project, change, patchset?, limit = 50 })`,
    `listBuildsets(t, { project, change, limit = 10 })`, `listJobs(t)`, `getJob(t, name)`,
    `listNodesets(t)`, `listProjectTemplates(t)` (derived from `/projects` detail if no endpoint — return `[]` on 404),
    `listSemaphores(t)`, `getProjectKey(t, project)` (`/key/{project}.pub`, text — keep literal
    `/` in `owner/repo`, do not URL-encode the slash), `getInfo(t)` (`/info`).
  - In-memory TTL cache (5 min) for `listJobs`, `listNodesets`, `listProjectTemplates`,
    `listSemaphores`, `listProjects`, keyed by tenant; `clearCache()`.
  - Normalised model in `zuulTypes.ts` (our own shape; map Zuul's JSON into it):
    ```ts
    interface ChangeStatus { pipeline: string; queue: string; live: boolean; enqueueTime?: number;
      remainingTimeMs?: number; jobs: JobStatus[]; itemsAhead: QueuedRef[] }
    interface JobStatus { name: string; uuid?: string; result?: string /* SUCCESS, FAILURE, ... */;
      running: boolean; elapsedMs?: number; remainingMs?: number; streamUrl?: string; reportUrl?: string }
    interface QueuedRef { project: string; change?: number; live: boolean; url?: string }
    interface Build { uuid: string; jobName: string; result?: string; pipeline: string; logUrl?: string;
      startTime?: string; endTime?: string; change?: number; patchset?: string; artifacts: { name: string; url: string }[] }
    ```
    `getChangeStatus` returns `ChangeStatus[]` (one per pipeline the change is in). Map both
    Zuul `/status/change/{pr},{sha}` array element shapes and put one fixture per format in
    `test/fixtures/zuul/`:
    - **Legacy item**: `{ pipeline?: string, queue_name?: string, id: "42,sha", project: "org/repo", live: true, enqueue_time: 1700000000000, remaining_time: 120000, item_ahead?: { id: "89,sha2", project: "org/dep", live: false, url: "..." }, items_ahead?: [...], jobs: [{ name, uuid, result, elapsed_time, remaining_time, url, report_url }] }`
    - **Modern item (`refs[]`)**: `{ pipeline: "check", queue: "shared", live: true, enqueue_time: 1700000000000, remaining_time: 120000, refs: [{ project: "ghe/org/repo", change: 42, patchset: "sha", ref_url: "..." }, { project: "ghe/org/dep", change: 89, ref_url: "..." }], jobs: [...] }` (extra `refs` entries beyond the target change become `itemsAhead` with `live: false`).
    `listBuilds` maps both flat fields (`project`, `change`, `patchset`, `job_name`, `log_url`, `start_time`, `end_time`, `artifacts`) and the newer nested `ref: { project, change, patchset }` object.
- **Don't:** poll, resolve tenants, or touch `vscode`.
- **Done when:**
  - `npm run check` passes
  - Tests cover both status formats, cache hit/expiry (fake `now`), 404 handling

### Step 6: Implement AuthService v1 (PAT + gh CLI)

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/auth/types.ts`, `src/auth/authService.ts`, `src/auth/patAuthProvider.ts`,
  `src/auth/ghCliAuthProvider.ts`, `test/unit/authService.test.ts`,
  `test/unit/patAuthProvider.test.ts`, `test/unit/ghCliAuthProvider.test.ts` (all new);
  `package.json`, `src/extension.ts` (edit)
- **Do:**
  - `types.ts`: `type AuthMethodId = 'oauth' | 'gh-cli' | 'pat'`;
    `interface TokenProvider { id: AuthMethodId; getToken(host: string, opts: { interactive: boolean }): Promise<string | undefined>; invalidate?(host: string): Promise<void> }`.
  - `PatAuthProvider(secrets: SecretStorageLike, validate: (host, token) => Promise<boolean>, prompt: PromptLike)`:
    secret key `zuul.pat.<host>`. `setToken(host)` prompts (`showInputBox`, `password: true`,
    placeholder "ghp_…"), validates via `GheClient.getUser()`, stores; invalid → error message,
    nothing stored. `getToken` reads secret; if missing and `interactive`, calls `setToken`.
    `clear(host)` deletes.
  - `GhCliAuthProvider(execFile)`: runs `gh auth token --hostname <host>` (5 s timeout). Returns
    trimmed stdout; `ENOENT`, non-zero exit or empty output → `undefined`. Caches per host 5 min.
  - `AuthService(providers: TokenProvider[], getMethod: () => 'auto' | AuthMethodId, logger)`:
    `getToken(host, { interactive })`. Method `pat` / `gh-cli` / `oauth` → only that provider.
    `auto` → try providers in this order: `['pat', 'gh-cli']` (Step 31 changes it). Logs which
    method produced a token, never the token. `reportUnauthorized(host)` → calls the provider's
    `invalidate` and clears the gh cache.
  - Commands: `zuul.setGhePat` ("Set GitHub Enterprise PAT"), `zuul.clearGhePat`
    ("Clear GitHub Enterprise PAT"). Host = current `GitContext.host`; if none, ask via input box.
- **Don't:** build OAuth. Don't read `GITHUB_TOKEN` env vars.
- **Done when:**
  - `npm run check` passes
  - Tests cover priority order, method pinning, gh `ENOENT`, invalid PAT not stored

### Step 7: Compose the Zuul context and resolve the tenant

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/context/tenantResolver.ts`, `src/context/zuulContext.ts`,
  `test/unit/tenantResolver.test.ts`, `test/unit/zuulContext.test.ts` (all new); `src/extension.ts` (edit)
- **Do:**
  - `tenantResolver.ts`: `resolveTenant(zuul: ZuulClient, project: string /* owner/repo */, configured?: string, cache?: KeyValueStore): Promise<string | undefined>`.
    Order: `configured` → cache (key `tenant:<zuulUrl>:<owner/repo>`) → for each tenant from
    `listTenants()` (sequential), `listProjects(t)` and match a project whose `name` equals
    `owner/repo` or whose `canonical_name` ends with `/<owner/repo>`. First match wins; store in
    cache. `KeyValueStore` = `{ get(k): string | undefined; update(k, v): Thenable<void> }`
    (`context.workspaceState` in production).
  - `zuulContext.ts`: `interface ResolvedContext extends GitContext { zuulUrl: string; tenant: string; project: string; ghe: GheClient; zuul: ZuulClient }`.
    `class ZuulContextService` recomputes on git-context or settings change; exposes
    `current: ResolvedContext | undefined`, `onDidChange`, and `problem?: 'no-repo' | 'no-zuul-url' | 'no-tenant'`.
    GheClient's `getToken` = `() => auth.getToken(host, { interactive: false })`.
    On `HttpError` 401 from GHE: `auth.reportUnauthorized(host)` and show the "Sign in" error
    (see Conventions).
  - `extension.ts`: when `problem === 'no-zuul-url'`, show a one-time info message
    "Set `zuul.url` to enable Zuul CI" with action "Open Settings" (`workbench.action.openSettings`, `zuul.url`).
- **Don't:** fetch PRs or statuses here.
- **Done when:**
  - `npm run check` passes
  - Tests cover configured tenant, cache hit, discovery by name and by canonical name, no match

### Step 8: Track the current PR and poll Zuul adaptively

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/services/prTracker.ts`, `src/services/pollSchedule.ts`,
  `test/unit/prTracker.test.ts`, `test/unit/pollSchedule.test.ts` (all new); `package.json`, `src/extension.ts` (edit)
- **Do:**
  - `pollSchedule.ts` (pure): `nextPollDelayMs(snapshot, fastUntil?: number, now)`: `3000` while
    `now < fastUntil` (trigger watch, Step 11); `15000` if any `ChangeStatus` exists (change is
    queued); else `60000`.
  - `prTracker.ts`: `interface PrSnapshot { pr: PullRequest; statuses: ChangeStatus[]; builds: Build[]; fetchedAt: number }`.
    `class PrTracker(ctx: ZuulContextService, logger, setTimer = setTimeout, now = Date.now)`:
    on context change, `findOpenPrForBranch`; then loop: `getChangeStatus(tenant, pr.number, pr.head.sha)`
    (**use the PR head SHA from GHE, not local HEAD**); when the result is empty, also
    `listBuilds(tenant, { project, change: pr.number, patchset: pr.head.sha })`. Re-fetch the PR
    itself every 4th tick (to see new pushes). Emits `onDidChange(snapshot | undefined)`.
    Exposes `refresh()`, `watchFor(ms)` (sets `fastUntil`), `snapshot`. Errors are logged with
    `[Poll]` and retried at the normal delay; never throw out of the loop. Stops when disposed.
    Pause polling while `vscode.window.state.focused` is false and resume + refresh on focus
    (inject a `focusEvents` interface for tests).
  - Command `zuul.refresh` ("Refresh") → `tracker.refresh()`; add it as `view/title` action
    (icon `$(refresh)`) on all three views.
- **Don't:** render anything (Steps 9–10).
- **Done when:**
  - `npm run check` passes
  - Tests use fake timers to cover 3 s / 15 s / 60 s cadence, fallback to builds, PR refetch, error resilience

### Step 9: Show pipeline status in the status bar

- **Tier:** haiku
- **Risk:** low
- **Status:** done
- **Files:** `src/services/statusBarText.ts` (new), `src/views/statusBar.ts` (new),
  `test/unit/statusBarText.test.ts` (new), `src/extension.ts` (edit)
- **Do:**
  - `src/services/statusBarText.ts` (pure):
    `statusBarText(snapshot: PrSnapshot | undefined, waiting: boolean): { text: string; tooltip: string } | undefined`.
    Rules, first match wins:
    - `waiting` → `$(sync~spin) Zuul: waiting for enqueue…`
    - no snapshot → `undefined` (hide)
    - a status exists: pick pipeline `gate` over `check` over others; `done` = jobs with a result;
      any `FAILURE`/`ERROR`/`TIMED_OUT`/`POST_FAILURE` → `$(error) Zuul <pipeline>: <n> failed`;
      else `$(sync~spin) Zuul <pipeline>: <done>/<total>` plus ` (ETA <m>m)` when
      `remainingTimeMs` is set (ceil minutes)
    - no status, builds exist: latest build per job; any failure → `$(error) Zuul <pipeline>: <n> failed`,
      else `$(check) Zuul <pipeline>: PASSED`
    - else `$(circle-outline) Zuul: no builds`
    - tooltip: `PR #<n>: <title>`
  - `statusBar.ts`: left-aligned item, priority 100, `command: 'workbench.view.extension.zuul-explorer'`;
    updates on `PrTracker.onDidChange`.
- **Don't:** add commands.
- **Done when:**
  - `npm run check` passes
  - Tests cover every rule above

### Step 10: Render the Builds tree (jobs per pipeline)

- **Tier:** sonnet
- **Risk:** low
- **Status:** done
- **Files:** `src/views/buildsTreeView.ts` (new), `src/services/buildsModel.ts` (new),
  `test/unit/buildsModel.test.ts` (new), `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `buildsModel.ts` (pure): `buildTree(snapshot): PipelineNode[]` where
    `PipelineNode { pipeline: string; live: boolean; jobs: JobNode[] }` and
    `JobNode { name: string; state: 'running' | 'queued' | 'success' | 'failure' | 'skipped' | 'other'; result?: string; uuid?: string; logUrl?: string; durationMs?: number }`.
    From `statuses` when present, else from latest build per job in `builds`. Sort jobs:
    failures first, then running, queued, success; alphabetical within.
  - `buildsTreeView.ts`: `TreeDataProvider` for `zuul.builds`. Pipeline items expanded;
    job items with `ThemeIcon` (`error`, `sync~spin`, `clock`, `pass`, `circle-slash`), description
    = result or elapsed time, `contextValue` = `zuulJob.<state>`. Clicking a job with `logUrl`
    opens it externally (`vscode.env.openExternal`) — replaced by the in-editor viewer in Step 19.
  - Update `viewsWelcome` for `zuul.builds`: "No Zuul builds for this pull request yet."
- **Don't:** fetch logs or artifacts.
- **Done when:**
  - `npm run check` passes

### Step 11: Post trigger comments and watch for enqueue

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/services/triggerService.ts`, `test/unit/triggerService.test.ts` (new);
  `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `TriggerService(ctx, tracker, logger, now)`: `post(comment: string)`:
    `ghe.postIssueComment(owner, repo, pr.number, comment)`, then remember the set of current
    `enqueueTime`s / build UUIDs, call `tracker.watchFor(45000)` and set `waiting = true`
    (exposed + `onDidChangeWaiting`). `waiting` ends when a snapshot shows a status item with a
    new `enqueueTime` or a new build UUID, or after 45 s → info message
    "Zuul has not picked up the comment yet." Status bar (Step 9) shows the waiting text.
  - Commands:
    - `zuul.postTrigger` ("Post Trigger Comment"): QuickPick of `settings.triggerComments`
      (label, `$(icon)` prefix, comment as detail).
    - `zuul.postCustomTrigger` ("Post Custom Trigger Comment..."): input box, non-empty.
    - Before posting always confirm with a modal: `Post "<comment>" on <owner/repo>#<n>?`.
  - Add both as `view/title` actions on `zuul.builds` (icons `$(comment)` and `$(comment-discussion)`),
    and register them in the Command Palette only `when: zuul.hasPr` (set this context key
    from `PrTracker` via `setContext`).
- **Don't:** add per-trigger toolbar buttons (dynamic menus aren't possible); the QuickPick is the decision.
- **Done when:**
  - `npm run check` passes
  - Tests cover success detection by new enqueue time, by new build, and timeout

### Step 12: Parse and edit `Depends-On` lines losslessly

- **Tier:** sonnet
- **Risk:** low
- **Status:** done
- **Files:** `src/services/dependsOnParser.ts`, `test/unit/dependsOnParser.test.ts` (new)
- **Do:**
  - Pure module, no I/O.
  - `interface DependsOnRef { raw: string; line: number; kind: 'url' | 'shorthand' | 'unknown'; host?: string; owner?: string; repo?: string; number?: number; url?: string }`.
  - `parseDependsOn(body: string | null): DependsOnRef[]`: lines matching
    `/^\s*depends-on:\s*(\S+)\s*$/im` (case-insensitive, per line). URL form
    `https://<host>/<owner>/<repo>/pull/<n>` (trailing `/`, `/files`, `#…` tolerated) → `url`;
    `owner/repo#n` → `shorthand`; else `unknown`. Dedupe by `owner/repo#n` (keep first).
  - `addDependsOn(body, url): string`: no-op if the same PR is already referenced. Preserve the
    body's line ending (`\r\n` if the body contains one, else `\n`). If the body ends with an
    existing contiguous block of `Depends-On:` lines, append to it; else append
    `<eol><eol>Depends-On: <url>` (single `<eol>` if body already ends with a blank line; just
    the line if body is empty). Never modify other lines.
  - `removeDependsOn(body, ref: { owner; repo; number }): string`: remove every matching line
    (any form); collapse a resulting run of 3+ blank lines at the end to none.
  - `toPrUrl(host, owner, repo, n)`.
- **Don't:** make network calls or import `vscode`.
- **Done when:**
  - `npm run check` passes
  - Tests cover CRLF/LF, checklists/markdown above, multiple deps, shorthand, duplicates, empty/null body, round-trip add→remove = original

### Step 13: Build the DependsOnService (enrich, sync check, cycles, Needed-By)

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/services/dependsOnService.ts`, `test/unit/dependsOnService.test.ts` (new)
- **Do:**
  - `DependsOnService(ghe: GheClient, zuul: ZuulClient, tenant: string, tenantProjects: () => Promise<Set<string>>)`.
  - `getUpstream(pr): Promise<UpstreamDep[]>`: for each parsed ref with owner/repo/number fetch
    the PR (in parallel, max 5) → `UpstreamDep { ref, pr?: PullRequest; state: 'open' | 'merged' | 'closed' | 'missing'; zuul?: ChangeStatus[]; inTenant: boolean; warning?: string }`.
    `warning`: `shorthand` → "Zuul ignores `owner/repo#n` — use the full URL"; not in tenant →
    "Repository is not part of tenant <t>".
  - `getDownstream(pr): Promise<SearchItem[]>`: `ghe.searchPrs('"<pr.html_url>" in:body is:open')`,
    excluding the PR itself.
  - `syncState(pr, statuses): { inSync: boolean; missingInZuul: string[]; extraInZuul: string[] }`
    (pure, exported separately): compare open upstream PRs from the body (as `owner/repo#n`) with
    `itemsAhead` where `live === false` across statuses (normalise `QueuedRef.project` by keeping
    the last two `/` segments `owner/repo` in case Zuul returns `host/owner/repo`). Only
    meaningful when `statuses` is non-empty; otherwise `inSync: true`.
  - `wouldCreateCycle(fromPr, targetPr): Promise<boolean>`: DFS over `Depends-On` bodies starting
    at `targetPr`, max depth 10, max 50 PRs fetched; true if `fromPr` is reached.
- **Don't:** write PR bodies here (Step 14).
- **Done when:**
  - `npm run check` passes
  - Tests cover enrichment states, sync diff both directions, cycle detected / not detected / depth limit

### Step 14: Add the Dependencies tree and Add/Remove `Depends-On` commands

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/views/dependsOnTreeView.ts`, `src/views/addDependsOnPick.ts` (new);
  `src/extension.ts`, `package.json` (edit)
- **Do:**
  - Tree `zuul.dependencies`: two root nodes "Depends On (<n>)" and "Needed By (<n>)". Upstream
    items: label `owner/repo#n`, description `<state> · <zuul pipeline result or "not in Zuul">`,
    icon by state (`git-pull-request`, `git-merge`, `git-pull-request-closed`, `warning`),
    tooltip includes `warning`. Click → open PR URL externally. When `syncState.inSync` is
    false, a first root item `$(warning) Out of sync with Zuul` with child lines for missing/extra
    and `contextValue: zuulOutOfSync`.
  - Commands:
    - `zuul.addDependsOn` ("Add Depends-On...") — view title `$(add)`. QuickPick items, in
      sections: "My open PRs" (`searchPrs('is:open author:@me')` filtered to tenant repos),
      "Workspace repositories" (open PRs for other repos open in the workspace, from
      `GitContextService` of other repositories if any), then live search as the user types
      (debounce 300 ms, `searchPrs('<text> is:open')`). Accept also a pasted PR URL. On pick:
      reject if not in tenant (error) or `wouldCreateCycle` (error "Would create a dependency cycle");
      re-fetch the current PR (fresh body), `addDependsOn`, `updatePrBody`, `tracker.refresh()`.
    - `zuul.removeDependsOn` ("Remove Depends-On") — inline `$(trash)` on upstream items;
      confirm modal; fresh body → `removeDependsOn` → `updatePrBody` → refresh.
    - `zuul.syncViaRecheck` ("Sync via Recheck") — inline on the out-of-sync item; calls
      `TriggerService.post('recheck')` (same confirmation as Step 11).
  - Data refresh: on `PrTracker.onDidChange`, but upstream/downstream fetches at most every 60 s
    unless the PR body changed.
- **Don't:** edit the body without re-fetching it immediately before the PATCH.
- **Done when:**
  - `npm run check` passes
  - Manual: in the Extension Development Host, the view renders with a mocked/real PR (note in report if not possible)

> **Checkpoint 1 (PR Status & Dependencies):** Status bar, **Builds** view, trigger comments, and **Dependencies** (`Depends-On` / `Needed-By`) are ready to test with a PAT or `gh` CLI.

### Step 15: Implement the pure gate-readiness evaluator

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/services/gateReadiness.ts`, `test/unit/gateReadiness.test.ts` (new)
- **Do:**
  - Pure module. Types:
    ```ts
    interface PrGateFacts { ref: string /* owner/repo#n */; draft: boolean; merged: boolean; state: 'open'|'closed';
      mergeableState?: string; labels: string[]; reviewDecision?: 'APPROVED'|'CHANGES_REQUESTED'|'REVIEW_REQUIRED';
      approvals: number; changesRequested: number;
      checks: { name: string; state: 'success'|'pending'|'failure'|'error'|'missing'; required: boolean }[];
      zuulCheck?: 'success'|'failure'|'running'|'none' }
    interface GateRules { requiredApprovals: number; requiredStatusChecks: Record<string,string[]>; requiredLabels: string[]; blockingLabels: string[] }
    interface Blocker { pr: string; kind: 'zuul-check'|'status-check'|'reviews'|'changes-requested'|'draft'|'mergeable'|'label-missing'|'label-blocking'|'closed'|'upstream'; message: string }
    interface GateReport { ready: boolean; items: { pr: string; checks: { label: string; ok: boolean; message?: string }[] }[]; blockers: Blocker[] }
    ```
  - `evaluateGate(root: PrGateFacts, upstream: PrGateFacts[], rules: GateRules): GateReport`.
    Per PR (root and each non-merged upstream):
    - Zuul check: `success` ok; else blocker "Zuul check is <x> on HEAD".
    - Status checks: required set = checks with `required: true` ∪ names in
      `rules.requiredStatusChecks['*']` ∪ `rules.requiredStatusChecks[owner/repo]`. Each
      required name whose state isn't `success` (or is absent → `missing`) → blocker
      "Required status check `<name>` is <state>".
    - Reviews: if `reviewDecision` present, ok iff `APPROVED`; else `approvals >= rules.requiredApprovals`.
      `changesRequested > 0` → separate blocker.
    - Draft → blocker; `mergeableState` in `dirty`, `blocked` → blocker "Merge state is <x>"
      (`blocked` only if no other blocker explains it — still report it, kind `mergeable`).
    - Labels: missing required, present blocking (case-insensitive).
    - Closed (not merged) upstream → blocker.
    - Upstream blockers are reported with `kind: 'upstream'` on the root and message
      "Blocked by upstream `<ref>`: <inner message>".
  - `ready` = no blockers.
- **Don't:** make network calls or import `vscode` in `gateReadiness.ts`.
- **Done when:**
  - `npm run check` passes
  - Tests cover each blocker kind, per-repo and `*` rules, reviewDecision vs count fallback, multi-level upstream

### Step 16: Collect gate facts from GHE and Zuul

- **Tier:** sonnet
- **Risk:** medium
- **Status:** done
- **Files:** `src/services/gateFacts.ts`, `test/unit/gateFacts.test.ts` (new)
- **Do:**
  - `collectGateFacts(ghe, zuul, tenant, pr: PullRequest): Promise<PrGateFacts>`:
    - `getPrRollup` → draft, labels, reviewDecision, checks with `isRequired` (StatusContext
      `state` / CheckRun `conclusion`+`status` mapped to the 5 states: `SUCCESS`/`NEUTRAL`/`SKIPPED`
      → success; `PENDING`/`EXPECTED`/`QUEUED`/`IN_PROGRESS` → pending; `FAILURE`/`CANCELLED`/
      `TIMED_OUT`/`ACTION_REQUIRED` → failure; `ERROR`/`STARTUP_FAILURE` → error).
    - If rollup is `undefined`: REST fallback — `listCommitStatuses` + `listCheckRuns` for
      checks, `getRequiredStatusChecks(base)` for `required` flags (missing required contexts
      become `missing`), draft/labels from the PR object.
    - Reviews: `listReviews`; keep the latest review per user; count `APPROVED` and `CHANGES_REQUESTED`.
    - `mergeableState` from `getPr` (`mergeable_state`).
    - `zuulCheck`: from `getChangeStatus` for pipeline `check` (running if jobs without result),
      else latest `check` buildset/builds for that SHA (`success` if all latest builds succeed),
      else `none`.
  - `collectUpstreamFacts(...)`: recursive over `Depends-On` of non-merged PRs, depth ≤ 5,
    dedupe by ref, parallelism 5.
- **Don't:** evaluate gate rules here (Step 15 does that).
- **Done when:**
  - `npm run check` passes
  - Tests cover rollup path, REST fallback, state mapping table, latest-review-per-user

### Step 17: Render the Gate Readiness tree

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/views/prGateTreeView.ts` (new); `src/extension.ts`, `package.json` (edit)
- **Do:**
  - Tree `zuul.gateReadiness`: header item `$(pass-filled) Ready for gate` or
    `$(circle-slash) Not ready: <n> blocker(s)`; then one node per PR (root first, then upstream)
    with checklist children (`$(check)` / `$(x)` + label + message). Blocker messages of
    `kind: 'upstream'` shown under the root as well.
  - Refresh when `PrTracker` emits, at most every 30 s (cache facts by PR head SHA + `updated_at`).
  - View title actions: `zuul.refresh`, `zuul.postTrigger`.
  - Update its `viewsWelcome` with a link to `zuul.setGhePat` when no token is available
    (context key `zuul.signedIn`, set by `AuthService` after every `getToken`).
- **Don't:** duplicate blocker logic in the view; delegate to `collectGateFacts` + `evaluateGate`.
- **Done when:**
  - `npm run check` passes

> **Checkpoint 2 (Full Sidebar — recommended first install):** All three sidebar views (**Gate Readiness**, **Dependencies**, **Builds**) are live. Run `npm run package && code --install-extension zuul-vscode-0.0.1.vsix` to test the full PR workflow.

### Step 18: Parse job output and manifests (ArtifactService)

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/services/artifactService.ts`, `test/unit/artifactService.test.ts`,
  `test/fixtures/logs/job-output.json`, `test/fixtures/logs/job-output.json.gz`,
  `test/fixtures/logs/zuul-manifest.json` (all new)
- **Do:**
  - `extractFailedTasks(jobOutput: unknown): FailedTask[]` — input is the parsed
    `job-output.json` array of playbooks `{ playbook, phase, plays: [{ play: { name }, tasks: [{ task: { name }, hosts: { [host]: { failed?, rc?, msg?, stdout?, stderr?, cmd? } } }] }] }`.
    A host result is failed if `failed === true` or `rc` is a non-zero number. Ignore results
    with `ignore_errors: true`. `FailedTask { playbook, play, task, host, cmd?, rc?, msg?, stdout?, stderr? }`.
  - `formatFailedTask(t): string` — YAML-ish text block (headings `playbook:`, `task:`, `host:`,
    `rc:`, `cmd:`, then `--- msg ---`, `--- stdout ---`, `--- stderr ---` sections).
  - `parseManifest(json): ManifestNode[]` — `{ tree: [{ name, mimetype, size?, children? }] }`
    → `ManifestNode { name; path; isDir; size? }` with full relative paths.
  - `matchPinned(paths: string[], patterns: string[]): string[]` using `picomatch`
    (`{ dot: true }`), stable order by pattern then path.
  - `ArtifactService(http: HttpClient)`: `fetchJobOutput(logUrl)` (tries `job-output.json`,
    then `job-output.json.gz`), `fetchManifest(logUrl)`; `logUrl` always joined with a single `/`.
- **Don't:** import `vscode` in `artifactService.ts`.
- **Done when:**
  - `npm run check` passes

### Step 19: Extend the Builds tree with failed tasks, pinned files and log browsing

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `src/views/buildsTreeView.ts`, `src/extension.ts`, `package.json` (edit);
  `src/views/taskDocumentProvider.ts` (new)
- **Do:**
  - Job items with `logUrl` become collapsible. Children (lazy, fetched on expand, cached per
    build UUID):
    1. For failed jobs: `$(flame) Failed Task: <task> [<host>]` per `extractFailedTasks`.
       Click → open `zuul-task:/<uuid>/<index>.txt` (provider keeps an in-memory map of
       formatted text; read-only).
    2. Build `artifacts` from the Builds API (`$(package)`), click → open URL externally.
    3. Pinned files: manifest paths matching `settings.pinnedArtifacts` (`$(pin)`), click →
       open in the log viewer (Step 20 command `zuul.openLog` with the absolute URL).
    4. `$(folder) Browse All Logs` → lazily expands the manifest tree (dirs collapsible,
       files open via `zuul.openLog`).
  - Fetch errors show a single child `$(warning) Could not load logs: <message>`.
  - Until Step 20 exists, `zuul.openLog` may be a stub that opens externally — Step 20 replaces it.
- **Don't:** eagerly fetch `job-output.json` or `zuul-manifest.json` before the user expands a build.
- **Done when:**
  - `npm run check` passes

### Step 20: Open remote logs in the editor and link stack traces to workspace files

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/views/logDocumentProvider.ts`, `src/services/logLinks.ts`, `test/unit/logLinks.test.ts` (new);
  `src/extension.ts`, `package.json` (edit)
- **Do:**
  - URI format: `vscode.Uri.from({ scheme: 'zuul-log', path: '/<first 7 chars of uuid>/<relative path>', query: encodeURIComponent(<absolute url>) })`.
    `TextDocumentContentProvider` fetches via `HttpClient.getText` (gunzip handled there).
    Files > 20 MB: show the first 20 MB and a final line `… truncated, open in browser: <url>`.
  - Command `zuul.openLog(url: string, uuid?: string)` builds the URI and opens it; replace any
    stub from Step 19.
  - `logLinks.ts` (pure): `findPathRefs(text): { start: number; end: number; path: string; line?: number }[]`
    matching `File "<path>", line <n>` (Python) and `<path>:<line>(:<col>)?` where path has an
    extension and contains a `/` or is a bare file name with extension. Skip `http(s)://` URLs.
  - `DocumentLinkProvider` for scheme `zuul-log`: creates links lazily; `resolveDocumentLink`
    finds the file by trying successive path suffixes (drop leading segments one by one) with
    `workspace.findFiles('**/<suffix>', '**/node_modules/**', 1)`; caches results per suffix;
    target = file URI with `#L<line>` fragment. Unresolvable → no target (link does nothing).
  - Set language for `.yaml`/`.json`/`.log` logs via `vscode.languages.setTextDocumentLanguage` on open
    (`.txt` and `.log` → `log`).
- **Don't:** resolve workspace files inside `provideDocumentLinks` (keep resolution lazy in `resolveDocumentLink`).
- **Done when:**
  - `npm run check` passes
  - Tests cover Python traces, `path:line`, `path:line:col`, URLs ignored

### Step 21: Stream the live console of running jobs

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/services/logStreamService.ts`, `test/unit/logStreamService.test.ts` (new);
  `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `LogStreamService(zuulUrl, tenant, createSocket = (url) => new WebSocket(url))`:
    `stream(uuid, sink: { append(s: string): void; appendLine(s: string): void }): Disposable`.
    URL: `zuulUrl` with `https`→`wss`/`http`→`ws` + `/api/tenant/<t>/console-stream`. On open
    send `JSON.stringify({ uuid, logfile: 'console.log' })`; append every text message; on close
    append `--- stream closed (<code>) ---`. Dispose closes the socket.
  - Command `zuul.streamConsole` ("Stream Live Console") — inline action on job items with
    `contextValue` `zuulJob.running`; opens an `OutputChannel` named `Zuul: <job name>` (reuse
    per job) and shows it. Bearer token from Step 32 is not needed (stream is public).
- **Don't:** add the `ws` npm package; use the global `WebSocket`.
- **Done when:**
  - `npm run check` passes
  - Tests use a fake socket to cover URL building, initial message, messages, close

> **Checkpoint 3 (In-Editor Log Inspection):** Failed Ansible tasks, pinned artifacts, full log manifest browsing, clickable stack-trace links, and live console streaming are ready to test.

### Step 22: Bundle a JSON schema for Zuul YAML files

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `schemas/zuul-schema.json` (new), `package.json` (edit), `test/unit/schema.test.ts` (new)
- **Do:**
  - JSON Schema draft-07. Root: array of single-key objects; keys `job`, `project`,
    `project-template`, `nodeset`, `secret`, `pipeline`, `semaphore`, `queue`, `pragma`,
    `image`, `flavor`, `label`, `section`, `provider` (last five only as `type: object`).
    Model the common attributes of `job` (`name` required, `parent`, `description`, `abstract`,
    `final`, `protected`, `nodeset` (string or object), `pre-run`/`run`/`post-run`/`cleanup-run`
    (string or array), `roles`, `required-projects`, `vars`, `host-vars`, `group-vars`,
    `extra-vars`, `secrets`, `timeout`, `post-timeout`, `attempts`, `voting`, `files`,
    `irrelevant-files`, `branches`, `dependencies`, `semaphores`, `tags`, `provides`, `requires`),
    `project` (`name`, `templates`, `queue`, `default-branch`, `merge-mode`, plus any other key
    = pipeline config `{ jobs: [string | { <job>: {...} }], queue?, debug?, fail-fast? }` via
    `additionalProperties`), `project-template`, `nodeset` (`name`, `nodes`, `groups`,
    `alternatives`), `secret` (`name`, `data`), `semaphore` (`name`, `max`), `queue` (`name`,
    `per-branch`, `allow-circular-dependencies`, `dependencies-by-topic`), `pragma`. Use
    `additionalProperties: true` for `pipeline`. Add `description`s from the Zuul docs.
  - `contributes.yamlValidation`: `[{ "fileMatch": [".zuul.yaml", "zuul.yaml", "zuul.d/*.yaml", ".zuul.d/*.yaml", "zuul.d/**/*.yaml", ".zuul.d/**/*.yaml"], "url": "./schemas/zuul-schema.json" }]`.
  - Test: the schema parses as JSON, and `yaml`-parsed fixture `test/fixtures/zuul-config/.zuul.yaml`
    (a realistic sample with every top-level type) has only known top-level keys
    (no validator dependency — check keys by hand in the test).
- **Don't:** add `redhat.vscode-yaml` to `extensionDependencies` or add `ajv`.
- **Done when:**
  - `npm run check` passes

### Step 23: Index the workspace Zuul config with source positions

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `src/language/configIndex.ts`, `src/language/yamlContext.ts`,
  `test/unit/configIndex.test.ts`, `test/unit/yamlContext.test.ts` (new)
- **Do:**
  - `configIndex.ts` (pure core + thin watcher):
    `parseZuulFile(uri: string, text: string): IndexEntry[]` using `yaml.parseDocument` with
    `keepSourceTokens`; `IndexEntry { kind: 'job'|'nodeset'|'project-template'|'project'|'secret'|'semaphore'; name: string; uri: string; range: { start: number; end: number } /* offsets of the whole item */; nameRange; node: unknown /* plain JS value */ }`.
    Tolerate parse errors (return entries that parsed).
    `class ConfigIndex { update(uri, text); remove(uri); find(kind, name): IndexEntry[]; all(kind) }`.
    Adapter `watchWorkspaceConfig(index)` using `workspace.findFiles` + `createFileSystemWatcher`
    with the glob `{.zuul.yaml,zuul.yaml,zuul.d/**/*.yaml,.zuul.d/**/*.yaml}` and
    `onDidChangeTextDocument` for open docs (debounce 300 ms).
  - `yamlContext.ts` (pure): `keyPathAt(text: string, offset: number): string[]` using an
    indentation heuristic (works on incomplete YAML): walk lines upward collecting the nearest
    less-indented `key:` / `- key:` ancestors. E.g. cursor after `parent: ` inside a job →
    `['job', 'parent']`; inside `project: > check: > jobs: > - ` → `['project', 'check', 'jobs', '-']`.
    Also `currentScalarRange(text, offset)` for the word under the cursor.
- **Don't:** register language providers yet (Steps 24–26).
- **Done when:**
  - `npm run check` passes
  - Tests cover multi-document files, `zuul.d` multi-file, syntax errors, key paths for parent/nodeset/templates/jobs/run

### Step 24: Provide completion and hover for Zuul YAML

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/language/completionProvider.ts`, `src/language/hoverProvider.ts`,
  `src/language/suggestions.ts`, `test/unit/suggestions.test.ts` (new); `src/extension.ts` (edit)
- **Do:**
  - `suggestions.ts` (pure): `suggestionsFor(keyPath, sources): Suggestion[]` where sources =
    local index entries + Zuul API lists (`listJobs`, `listNodesets`, `listProjectTemplates`,
    `listSemaphores`). Mapping: `[...,'parent']` and `[project|project-template, <pipeline>, 'jobs', '-']`
    → jobs; `[...,'nodeset']` → nodesets; `['project'|'project-template','templates','-']` →
    templates; `[...,'semaphores', ...]` → semaphores. Local items first, then remote; dedupe by name.
    `Suggestion { label; detail /* source repo or "workspace" */; documentation /* description */ }`.
  - Providers registered for selector `{ language: 'yaml', pattern: '**/{.zuul.yaml,zuul.yaml,zuul.d/**/*.yaml,.zuul.d/**/*.yaml}' }`.
    Remote lists fail silently (local only) when not signed in / no tenant.
  - Hover on a job/nodeset/template name value: description, parent, source (local file link or
    Zuul Web URL `<zuulUrl>/t/<tenant>/job/<name>`).
- **Don't:** show error popups when Zuul API calls fail during autocomplete/hover.
- **Done when:**
  - `npm run check` passes

### Step 25: Go to definition for playbooks, roles, jobs and nodesets

- **Tier:** sonnet
- **Risk:** low
- **Status:** todo
- **Files:** `src/language/definitionProvider.ts`, `src/language/definitionTargets.ts`,
  `test/unit/definitionTargets.test.ts` (new); `src/extension.ts` (edit)
- **Do:**
  - `definitionTargets.ts` (pure): given keyPath + scalar value, return a target:
    `pre-run`/`run`/`post-run`/`cleanup-run` → `{ kind: 'file', relPath: value }` (relative to
    the repo root; if no extension, try `.yaml` then `.yml`); `roles` items `{ name }` or
    `{ zuul: proj, name }` → `{ kind: 'role', name }` resolved to `roles/<name>/tasks/main.y(a)ml`
    in the repo; `parent`/job names → `{ kind: 'job', name }`; `nodeset` → `{ kind: 'nodeset', name }`.
  - Provider: files/roles → `Location` if the file exists; job/nodeset → local `ConfigIndex`
    `nameRange` locations; if not local, return nothing and instead expose a `DocumentLink`
    to `<zuulUrl>/t/<tenant>/job/<name>` (register a small link provider) so Cmd+Click opens Zuul Web.
- **Don't:** fetch remote job definitions over HTTP on every cursor move.
- **Done when:**
  - `npm run check` passes

### Step 26: Preview the effective (flattened) job via CodeLens

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `src/language/effectiveJob.ts`, `src/language/effectiveJobLens.ts`,
  `test/unit/effectiveJob.test.ts` (new); `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `effectiveJob.ts` (pure): `resolveChain(name, lookup: (name) => Promise<JobDef | undefined>): Promise<JobDef[]>`
    (child first, follows `parent`, stops at missing parent or depth 20, detects loops; implicit
    root parent `base` unless `parent: null`). `JobDef` = normalised `{ name, parent?, preRun: string[], run: string[], postRun: string[], cleanupRun: string[], vars, hostVars, groupVars, roles, requiredProjects, timeout?, nodeset?, source: 'workspace' | 'zuul' }`.
    `flatten(chain): JobDef` with Zuul semantics: `preRun` parent→child order; `postRun` and
    `cleanupRun` child→parent order; `run` = nearest non-empty; `vars`/`hostVars`/`groupVars`
    deep-merged, child wins; `roles`, `requiredProjects` union in parent→child order, deduped;
    `timeout`, `nodeset` nearest defined. Output `inheritance: string[]`.
  - Lookup order: workspace `ConfigIndex` first (first entry), else `zuul.getJob(t, name)`
    (first variant; map `pre_run`/`run`/`post_run` playbook objects' `path`, `variables`, etc.).
  - CodeLens `$(eye) Preview Effective Job` above every `- job:` item in Zuul YAML files →
    command `zuul.previewEffectiveJob(name)` opens `zuul-effective:/<name>.yaml` (read-only
    content provider, `yaml.stringify` of the flattened job with a header comment listing
    `inheritance`) in `ViewColumn.Beside`.
- **Don't:** resolve remote parents inside `provideCodeLenses` (only fetch when the user clicks the CodeLens).
- **Done when:**
  - `npm run check` passes
  - Tests cover ordering rules, `parent: null`, missing remote parent, loop detection

### Step 27: Simulate `files` / `irrelevant-files` against the git diff

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `src/services/fileMatcher.ts`, `src/services/gitDiff.ts`, `test/unit/fileMatcher.test.ts`,
  `test/unit/gitDiff.test.ts` (new); `src/language/effectiveJobLens.ts`, `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `fileMatcher.ts` (pure): `toRegex(p)` = `new RegExp(p)` tested with **`.match` semantics**:
    anchored at the start only (`new RegExp('^(?:' + p + ')')`). Invalid regex → reported, job
    marked `unknown`. `jobRuns(changed: string[], files?: string[], irrelevant?: string[]): boolean`:
    runs iff (`files` empty/undefined OR some changed file matches some `files` regex) AND
    (`irrelevant` empty/undefined OR some changed file matches no `irrelevant` regex). Empty
    `changed` → runs.
    `evaluateProject(changed, jobs: { name; files?; irrelevantFiles?; source }[]): { name; runs: boolean | 'unknown'; reason: string }[]`.
    Project-pipeline job entries with their own `files`/`irrelevant-files` override the job definition.
  - `gitDiff.ts`: `changedFiles(repoRoot, mode: 'staged' | 'working' | 'branch', baseRef?, execFile)`
    using `git diff --name-only --cached` / `git diff --name-only HEAD` / `git diff --name-only <merge-base>...HEAD`
    where base = PR base branch from `PrTracker` or `origin/main` fallback (`git merge-base origin/<base> HEAD`).
  - Command `zuul.whichJobsRun` ("Which Jobs Run on Current Diff?"): QuickPick for mode, then
    lists jobs from all `project` entries in the workspace index (every pipeline), showing
    `$(check)`/`$(circle-slash)`/`$(question)` per job grouped by pipeline in a QuickPick.
    Job definitions missing locally use `zuul.getJob` `files`/`irrelevant_files`; failure → `unknown`.
  - CodeLens `$(check-all) Test File Matchers against Git Diff` on jobs that define `files` or
    `irrelevant-files` → runs the same evaluation for that job only (mode `branch`), shows the
    result in an info message.
- **Don't:** run `git fetch` or modify the working tree.
- **Done when:**
  - `npm run check` passes
  - Tests cover start-anchoring, files only, irrelevant only, both, invalid regex, project override

### Step 28: Encrypt secrets for the current project

- **Tier:** sonnet
- **Risk:** high
- **Status:** todo
- **Files:** `src/services/secretEncryptor.ts`, `test/unit/secretEncryptor.test.ts` (new);
  `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `secretEncryptor.ts` (pure, node `crypto`): `encryptForZuul(publicKeyPem: string, plaintext: string): string[]`
    — key size `k` bytes from `crypto.createPublicKey(pem).asymmetricKeyDetails.modulusLength / 8`;
    chunk size `k - 2*20 - 2` (OAEP with SHA-1); split the UTF-8 **bytes**; each chunk
    `crypto.publicEncrypt({ key, padding: RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, chunk)` →
    base64. `formatYaml(field: string, chunks: string[], indent: string): string` →
    ```
    <indent><field>: !encrypted/pkcs1-oaep
    <indent>  - <chunk1 base64>
    <indent>  - <chunk2 base64>
    ```
    (one line per chunk, no wrapping).
  - Command `zuul.encryptSecret` ("Encrypt Secret for Current Project"): project = current
    `owner/repo` (input box prefilled, editable); key via `zuul.getProjectKey`; plaintext =
    current selection if non-empty, else `showInputBox({ password: true })`; field name input
    (default `password`). Then QuickPick "Insert at cursor" / "Copy to clipboard". Insert
    replaces the selection, indent = current line's leading whitespace.
  - Tests generate 2048- and 4096-bit keys with `crypto.generateKeyPairSync`, decrypt each
    chunk with the private key (`oaepHash: 'sha1'`), reassemble, compare; cover multi-chunk
    plaintext (> chunk size), UTF-8 multibyte across chunk boundary, YAML format.
- **Don't:** log plaintext or ciphertext. No third-party crypto.
- **Done when:**
  - `npm run check` passes

> **Checkpoint 4 (`.zuul.yaml` Authoring):** Schema validation, autocomplete, hover, go-to-definition, effective job preview CodeLens, file matcher simulator, and secret encryption are ready to test on repos with `.zuul.yaml` / `zuul.d/`.

### Step 29: Add GHE OAuth via VS Code's built-in `github-enterprise` provider

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `src/auth/gheOAuthProvider.ts`, `test/unit/gheOAuthProvider.test.ts` (new);
  `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `GheOAuthProvider` implements `TokenProvider` with `id: 'oauth'`, injected
    `authentication` + `configuration` + `prompt` facades.
    - Provider id: `github` when host is `github.com`, else `github-enterprise`.
    - For GHE: if `github-enterprise.uri` (global setting) is empty or a different host, and
      `interactive`, ask (modal) "Use https://<host> as GitHub Enterprise server for VS Code
      sign-in?" → on yes, update it at `ConfigurationTarget.Global`. If it points to another
      host and the user declines → return `undefined`.
    - `getSession(providerId, ['repo', 'read:user'], interactive ? { createIfNone: true } : { silent: true })`
      → `accessToken`.
  - Commands `zuul.signIn` ("Sign In") → `auth.getToken(host, { interactive: true })` using
    method `oauth` when available; `zuul.signOut` ("Sign Out") → clears PAT and gh cache and
    tells the user to sign out of the VS Code account via the Accounts menu (VS Code sessions
    can't be removed by extensions).
  - Register the provider in `AuthService` but keep the Step 6 `auto` order for now (`['pat','gh-cli','oauth']`).
- **Don't:** switch the default `zuul.auth.method` yet (Step 31) or implement Device Flow here (Step 30).
- **Done when:**
  - `npm run check` passes
  - Tests cover github.com vs GHE ids, setting update consent, silent vs interactive

### Step 30: Add GHE OAuth Device Flow with an own AuthenticationProvider

- **Tier:** opus
- **Risk:** high
- **Status:** todo
- **Files:** `src/auth/deviceFlow.ts`, `src/auth/zuulGheAuthenticationProvider.ts`,
  `test/unit/deviceFlow.test.ts`, `test/unit/zuulGheAuthenticationProvider.test.ts` (new);
  `src/auth/gheOAuthProvider.ts`, `src/extension.ts`, `package.json` (edit)
- **Do:**
  - Used only when `zuul.ghe.oauthClientId` is set (then it replaces Step 29's built-in provider
    path for that host).
  - `deviceFlow.ts` (pure, injected `fetchFn`, `sleep`, `now`):
    `startDeviceFlow(host, clientId, scopes)` → `POST https://<host>/login/device/code`
    (form-encoded `client_id`, `scope`; `Accept: application/json`) →
    `{ device_code, user_code, verification_uri, interval, expires_in }`.
    `pollForToken(host, clientId, deviceCode, interval, expiresIn, signal)` → `POST https://<host>/login/oauth/access_token`
    with `grant_type=urn:ietf:params:oauth:grant-type:device_code`; handle
    `authorization_pending` (wait `interval`), `slow_down` (interval += 5 s), `expired_token`,
    `access_denied` (throw typed errors); returns `{ access_token, scope, refresh_token?, expires_in? }`.
    For github.com the same endpoints live on `github.com`.
  - `ZuulGheAuthenticationProvider` implements `vscode.AuthenticationProvider`, registered via
    `vscode.authentication.registerAuthenticationProvider('zuul-ghe', 'Zuul: GitHub Enterprise', provider, { supportsMultipleAccounts: false })`
    and `contributes.authentication` in `package.json`. `createSession`: start flow, copy
    `user_code` to the clipboard, show a modal with the code and "Open Browser" →
    `env.openExternal(verification_uri)`, poll with a cancellable `withProgress` notification.
    Account label from `GET /user`. Sessions (JSON, including host) stored in `context.secrets`
    under `zuul.oauth.sessions`. `removeSession` deletes it. If `refresh_token` + `expires_in`
    were returned, refresh 5 min before expiry via `grant_type=refresh_token`.
  - `GheOAuthProvider.getToken`: if `oauthClientId` set → `getSession('zuul-ghe', scopes, …)`.
- **Don't:** implement PKCE / URI handler. Don't log codes or tokens.
- **Done when:**
  - `npm run check` passes
  - Tests cover pending → slow_down → success, expired, denied, cancellation, refresh

### Step 31: Make OAuth the default authentication

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `package.json`, `src/auth/authService.ts`, `src/config/settings.ts`,
  `test/unit/authService.test.ts`, `test/unit/settings.test.ts`, `src/extension.ts` (edit)
- **Do:**
  - `zuul.auth.method` default → `"auto"` (package.json + `settings.ts` default + tests).
  - `auto` order → `['oauth', 'gh-cli', 'pat']`; non-interactive OAuth uses `silent: true`.
    When nothing returns a token and `interactive` is true: QuickPick
    "Sign in with GitHub Enterprise (recommended)" (→ oauth interactive) / "Enter a Personal
    Access Token" (→ PAT `setToken`).
  - Error "Sign in" actions and the Gate Readiness welcome link now use `zuul.signIn`.
  - Status bar: when not signed in and a PR context exists, show `$(account) Zuul: Sign in`
    (command `zuul.signIn`).
- **Don't:** prompt interactively during background polling (`interactive: false` must stay silent).
- **Done when:**
  - `npm run check` passes
  - Tests cover the new order, the fallback QuickPick choice routing, and the default

> **Checkpoint 5 (OAuth Sign-In):** Default OAuth sign-in (VS Code built-in `github-enterprise` / `github` provider + Device Flow) is ready to test via `Zuul: Sign In`.

### Step 32: Support a Zuul bearer token and privileged actions

- **Tier:** sonnet
- **Risk:** high
- **Status:** todo
- **Files:** `src/auth/zuulAuthProvider.ts`, `test/unit/zuulAuthProvider.test.ts` (new);
  `src/clients/zuulClient.ts`, `test/unit/zuulClient.test.ts`, `src/views/buildsTreeView.ts`,
  `src/extension.ts`, `package.json` (edit)
- **Do:**
  - `ZuulAuthProvider(secrets)`: key `zuul.token.<zuulUrl>`; `setToken` (password input box;
    hint "Copy a token from Zuul Web (user menu) or `zuul-client`"), `getToken`, `clear`.
    Reject tokens whose JWT `exp` (decode the payload, no verification) is in the past.
  - `ZuulClient` additions (send `Authorization: Bearer`): `dequeue(t, project, { pipeline, change, ref? })`
    → `POST /api/tenant/{t}/project/{project}/dequeue`; `enqueue(t, project, { pipeline, change })`
    → `.../enqueue`; `autohold(t, project, { job, change, reason, count: 1, node_hold_expiration: 86400 })`
    → `.../autohold` (keep literal `/` in `project` `owner/repo`). 401/403 → error "Zuul rejected
    the token (no admin rights for this tenant?)".
  - Commands: `zuul.setZuulToken`, `zuul.clearZuulToken`, `zuul.dequeue` (pipeline item
    context), `zuul.enqueue` (QuickPick of pipelines seen in builds/status, default `check`),
    `zuul.autohold` (failed job item context). Every action: modal confirmation naming the
    tenant, project, change and pipeline/job. Menus only `when: zuul.hasZuulToken`.
- **Don't:** implement an OIDC browser login.
- **Done when:**
  - `npm run check` passes
  - Tests cover request shapes, expired JWT rejection, 403 message

### Step 33: Add extension-host integration tests against mock servers

- **Tier:** sonnet
- **Risk:** medium
- **Status:** todo
- **Files:** `test/integration/**` (new), `.vscode-test.mjs` (new), `package.json` (edit)
- **Do:**
  - Script `test:integration` (`vscode-test`); **not** part of `npm run check` (downloads VS Code).
  - `test/integration/mockServer.ts`: one `node:http` server on a random port serving both GHE
    (`/api/v3/...`, `/api/graphql`) and Zuul (`/api/...`) from in-memory state; records
    requests. Workspace fixture `test/integration/fixture-repo` with `.git` remote pointing at
    `http://127.0.0.1:<port>/acme/app` (created at test start with `git init` + `git remote add`),
    `.vscode/settings.json` with `zuul.url`, `zuul.tenant`, `zuul.ghe.host`.
    GheClient must allow `http://` for `127.0.0.1` only: add `gheBaseUrlOverride` (internal,
    env `ZUUL_VSCODE_TEST_GHE_URL`) — the only test hook allowed.
  - Flow test: store a PAT via `zuul.setGhePat` (stub input box) → PR detected → status bar text
    → `zuul.addDependsOn` with a pasted URL (stub QuickPick) → mock PATCH body contains
    `Depends-On:` → mock Zuul status without that item → out-of-sync item present →
    `zuul.syncViaRecheck` posts `recheck` → `zuul.openLog` shows mock log content.
- **Don't:** add `test:integration` to `npm run check`.
- **Done when:**
  - `npm run check` passes
  - `npm run test:integration` passes locally (needs network once; report if not possible)

### Step 34: Write the user docs and changelog

- **Tier:** haiku
- **Risk:** low
- **Status:** todo
- **Files:** `README.md`, `CHANGELOG.md`, `docs/configuration.md`, `docs/development.md` (new)
- **Do:**
  - `README.md` (short): what it is, feature list (one line each), requirements (VS Code
    ≥ 1.100, Zuul with multi-tenant API, Red Hat YAML extension for schema validation),
    quick start (set `zuul.url`, sign in), links to the two docs.
  - `docs/configuration.md`: settings table (copy from `package.json` `contributes.configuration`),
    auth methods and order (`auto` = OAuth → gh CLI → PAT), Device Flow setup (OAuth App with
    Device Flow enabled, scopes `repo read:user`), corporate CAs (`NODE_EXTRA_CA_CERTS`,
    `http.proxySupport`), Zuul token for privileged actions, example `.vscode/settings.json`
    with `zuul.triggerComments`.
  - `docs/development.md`: `npm install`, `npm run check`, `npm run watch` + F5,
    `npm run test:integration`, `npm run package`, project layout (one line per folder).
  - `CHANGELOG.md`: Keep a Changelog format, `## [Unreleased]` with an `### Added` list of the features.
- **Don't:** rewrite or delete `IMPLEMENTATION_PLAN.md`.
- **Done when:**
  - `npm run check` passes (prettier formats the markdown)

## Out of scope

- OAuth Authorization Code + PKCE / URI handler (Device Flow only).
- Zuul OIDC browser login (bearer token paste only).
- Whitelabeled Zuul tenants and Gerrit / GitLab connections.
- Marketplace publishing, telemetry, localisation.
- Full JSON-schema validation inside unit tests (no validator dependency).
- Removing or rewriting `IMPLEMENTATION_PLAN.md`.

