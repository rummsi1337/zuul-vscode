import { HttpClient, HttpError } from './http';
import { type Logger } from '../util/logger';
import {
  type Build,
  type Buildset,
  type ChangeStatus,
  type JobStatus,
  type ListBuildsetsOptions,
  type ListBuildsOptions,
  type QueuedRef,
  type ZuulInfo,
  type ZuulJobSummary,
  type ZuulJobVariant,
  type ZuulNodeset,
  type ZuulProject,
  type ZuulProjectTemplate,
  type ZuulSemaphore,
  type ZuulTenant,
} from './zuulTypes';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface RawJobStatus {
  name?: string;
  uuid?: string | null;
  result?: string | null;
  running?: boolean;
  elapsed_time?: number | null;
  remaining_time?: number | null;
  voting?: boolean;
  pipeline?: string;
  report_url?: string | null;
}

interface RawChangeStatusItem {
  pipeline?: string;
  queue?: string;
  live?: boolean;
  enqueue_time?: number | null;
  remaining_time?: number | null;
  jobs?: RawJobStatus[] | null;
}

interface RawStatusRef {
  id?: string;
  project?: string;
  project_canonical?: string;
  url?: string;
}

interface RawQueueItem {
  id?: string;
  live?: boolean;
  item_ahead?: string | null;
  refs?: RawStatusRef[] | null;
}

interface RawTenantStatus {
  pipelines?:
    | {
        change_queues?: { heads?: (RawQueueItem[] | null)[] | null }[] | null;
      }[]
    | null;
}

interface RawBuildRef {
  project?: string;
  change?: number | string;
  patchset?: string | number;
}

interface RawBuild {
  uuid?: string;
  job_name?: string;
  result?: string | null;
  pipeline?: string;
  log_url?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  project?: string;
  change?: number | string | null;
  patchset?: string | number | null;
  ref?: RawBuildRef | null;
  voting?: boolean;
  artifacts?: { name?: string; url?: string }[] | null;
}

interface RawBuildset {
  uuid?: string;
  result?: string | null;
  pipeline?: string;
  project?: string;
  change?: number | string | null;
  patchset?: string | number | null;
  ref?: RawBuildRef | null;
  refs?: RawBuildRef[] | null;
  builds?: RawBuild[] | null;
}

function parseChangeNumber(change?: number | string | null, id?: string): number | undefined {
  if (typeof change === 'number' && Number.isFinite(change)) {
    return change;
  }
  if (typeof change === 'string' && change.trim().length > 0) {
    const parsed = Number.parseInt(change, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof id === 'string' && id.length > 0) {
    const firstPart = id.split(',')[0];
    const parsed = Number.parseInt(firstPart, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function normalizeJobStatus(raw: RawJobStatus): JobStatus {
  const hasResult = raw.result !== undefined && raw.result !== null && raw.result !== '';
  const running = hasResult
    ? false
    : typeof raw.running === 'boolean'
      ? raw.running
      : raw.elapsed_time !== undefined && raw.elapsed_time !== null
        ? true
        : Boolean(raw.uuid);

  const job: JobStatus = {
    name: raw.name ?? '',
    running,
  };

  if (raw.uuid) {
    job.uuid = raw.uuid;
  }
  if (hasResult && raw.result) {
    job.result = raw.result;
  }
  if (typeof raw.elapsed_time === 'number') {
    job.elapsedMs = raw.elapsed_time;
  }
  if (typeof raw.remaining_time === 'number') {
    job.remainingMs = raw.remaining_time;
  }
  if (typeof raw.voting === 'boolean') {
    job.voting = raw.voting;
  }
  if (raw.report_url) {
    job.reportUrl = raw.report_url;
  }

  return job;
}

export function normalizeChangeStatus(raw: RawChangeStatusItem): ChangeStatus {
  const jobs = (raw.jobs ?? []).map(normalizeJobStatus);
  const pipeline = raw.pipeline ?? (raw.jobs ?? []).find((job) => job.pipeline)?.pipeline ?? '';

  // item_ahead is a UUID and refs[] lists bundle members, so neither is an item ahead.
  // The queue ahead is read from GET /status instead.
  const status: ChangeStatus = {
    pipeline,
    queue: raw.queue ?? '',
    live: raw.live ?? true,
    jobs,
    itemsAhead: [],
  };

  if (typeof raw.enqueue_time === 'number') {
    status.enqueueTime = raw.enqueue_time;
  }
  if (typeof raw.remaining_time === 'number') {
    status.remainingTimeMs = raw.remaining_time;
  }

  return status;
}

export function normalizeBuild(raw: RawBuild): Build {
  const build: Build = {
    uuid: raw.uuid ?? '',
    jobName: raw.job_name ?? '',
    pipeline: raw.pipeline ?? '',
    artifacts: (raw.artifacts ?? []).map((a) => ({
      name: a.name ?? '',
      url: a.url ?? '',
    })),
  };

  if (raw.result) {
    build.result = raw.result;
  }
  if (typeof raw.voting === 'boolean') {
    build.voting = raw.voting;
  }
  const logUrl = raw.log_url ?? undefined;
  if (logUrl) {
    build.logUrl = logUrl;
  }
  const startTime = raw.start_time ?? undefined;
  if (startTime) {
    build.startTime = startTime;
  }
  const endTime = raw.end_time ?? undefined;
  if (endTime) {
    build.endTime = endTime;
  }
  const project = raw.project ?? raw.ref?.project ?? undefined;
  if (project) {
    build.project = project;
  }
  const change = parseChangeNumber(raw.change ?? raw.ref?.change);
  if (change !== undefined) {
    build.change = change;
  }
  const rawPatchset = raw.patchset ?? raw.ref?.patchset;
  if (rawPatchset !== undefined && rawPatchset !== null) {
    build.patchset = String(rawPatchset);
  }

  return build;
}

function normalizeBuildset(raw: RawBuildset): Buildset {
  const primaryRef = raw.ref ?? raw.refs?.[0];
  const buildset: Buildset = {
    uuid: raw.uuid ?? '',
    pipeline: raw.pipeline ?? '',
  };

  if (raw.result) {
    buildset.result = raw.result;
  }
  const project = raw.project ?? primaryRef?.project;
  if (project) {
    buildset.project = project;
  }
  const change = parseChangeNumber(raw.change ?? primaryRef?.change);
  if (change !== undefined) {
    buildset.change = change;
  }
  const rawPatchset = raw.patchset ?? primaryRef?.patchset;
  if (rawPatchset !== undefined && rawPatchset !== null) {
    buildset.patchset = String(rawPatchset);
  }
  if (Array.isArray(raw.builds)) {
    buildset.builds = raw.builds.map(normalizeBuild);
  }

  return buildset;
}

export class ZuulClient {
  readonly baseUrl: string;
  private readonly getToken?: (tenant?: string) => Promise<string | string[] | undefined>;
  private readonly fetchFn?: typeof fetch;
  private readonly http: HttpClient;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly logger?: Pick<Logger, 'info' | 'warn'>;
  private readonly workingTokens = new Map<string, string>();

  constructor(
    baseUrl: string,
    getToken?: (tenant?: string) => Promise<string | string[] | undefined>,
    fetchFn?: typeof fetch,
    now: () => number = Date.now,
    logger?: Pick<Logger, 'info' | 'warn'>,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.getToken = getToken;
    this.fetchFn = fetchFn;
    this.now = now;
    this.logger = logger;
    this.http = new HttpClient({
      baseUrl: this.baseUrl,
      fetchFn: this.fetchFn,
      logger: this.logger,
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  private tenantPath(tenant: string, subPath: string): string {
    return `/api/tenant/${encodeURIComponent(tenant)}${subPath}`;
  }

  /**
   * Runs `call` with an Authorization header for each candidate token until one is accepted.
   * Only 401 and 403 responses move on to the next token; any other error is rethrown at once.
   */
  private async withAuth<T>(
    tenant: string | undefined,
    call: (headers: Record<string, string> | undefined) => Promise<T>,
  ): Promise<T> {
    const result = this.getToken ? await this.getToken(tenant) : undefined;
    const tokens = Array.isArray(result) ? result : result ? [result] : [];
    if (tokens.length === 0) {
      return call(undefined);
    }

    const key = tenant ?? '';
    const remembered = this.workingTokens.get(key);
    const ordered =
      remembered !== undefined && tokens.includes(remembered)
        ? [remembered, ...tokens.filter((token) => token !== remembered)]
        : tokens;

    let lastError: unknown;
    for (const token of ordered) {
      try {
        const value = await call({ Authorization: `Bearer ${token}` });
        this.workingTokens.set(key, token);
        return value;
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.cache.get(key) as CacheEntry<T> | undefined;
    const currentTime = this.now();
    if (existing !== undefined && currentTime < existing.expiresAt) {
      return existing.value;
    }

    const value = await loader();
    this.cache.set(key, {
      value,
      expiresAt: this.now() + CACHE_TTL_MS,
    });
    return value;
  }

  async listTenants(): Promise<ZuulTenant[]> {
    this.logger?.info(`[Zuul] Listing tenants on ${this.baseUrl}`);
    const raw = await this.withAuth(undefined, (headers) =>
      this.http.getJson<(ZuulTenant | string)[]>('/api/tenants', undefined, headers),
    );
    return raw.map((item) => (typeof item === 'string' ? { name: item } : item));
  }

  async listProjects(tenant: string): Promise<ZuulProject[]> {
    this.logger?.info(`[Zuul] Listing projects for tenant="${tenant}"`);
    return this.cached(`projects:${tenant}`, async () =>
      this.withAuth(tenant, (headers) =>
        this.http.getJson<ZuulProject[]>(this.tenantPath(tenant, '/projects'), undefined, headers),
      ),
    );
  }

  async getChangeStatus(tenant: string, pr: number | string, sha: string): Promise<ChangeStatus[]> {
    this.logger?.info(
      `[Zuul] Getting change status for tenant="${tenant}" change=${pr} patchset=${sha}`,
    );
    try {
      const raw = await this.withAuth(tenant, (headers) =>
        this.http.getJson<RawChangeStatusItem[]>(
          this.tenantPath(tenant, `/status/change/${pr},${sha}`),
          undefined,
          headers,
        ),
      );
      return raw.map((item) => normalizeChangeStatus(item));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        this.logger?.info(
          `[Zuul] Change status not found (404) for tenant="${tenant}" change=${pr} patchset=${sha}; returning empty status`,
        );
        return [];
      }
      throw err;
    }
  }

  async getQueueAhead(
    tenant: string,
    pr: number | string,
    sha: string,
  ): Promise<QueuedRef[] | undefined> {
    this.logger?.info(
      `[Zuul] Getting queue ahead for tenant="${tenant}" change=${pr} patchset=${sha}`,
    );
    const raw = await this.withAuth(tenant, (headers) =>
      this.http.getJson<RawTenantStatus>(this.tenantPath(tenant, '/status'), undefined, headers),
    );
    const byId = new Map<string, RawQueueItem>();
    const targets: RawQueueItem[] = [];
    const targetId = `${pr},${sha}`;
    for (const pipeline of raw.pipelines ?? []) {
      for (const queue of pipeline.change_queues ?? []) {
        for (const head of queue.heads ?? []) {
          for (const item of head ?? []) {
            if (item.id) {
              byId.set(item.id, item);
            }
            if ((item.refs ?? []).some((ref) => ref.id === targetId)) {
              targets.push(item);
            }
          }
        }
      }
    }

    // A PR that is not in the queue says nothing about its dependencies.
    if (targets.length === 0) {
      return undefined;
    }

    const liveTargets = targets.filter((item) => item.live !== false);
    const starts = liveTargets.length > 0 ? liveTargets : targets;
    const visited = new Set<string>();
    const result: QueuedRef[] = [];
    for (const start of starts) {
      let aheadId = start.item_ahead;
      while (aheadId && !visited.has(aheadId)) {
        visited.add(aheadId);
        const ahead = byId.get(aheadId);
        if (!ahead) {
          break;
        }
        for (const ref of ahead.refs ?? []) {
          const project = ref.project ?? ref.project_canonical;
          if (!project) {
            continue;
          }
          const queued: QueuedRef = { project, live: ahead.live ?? true };
          const change = parseChangeNumber(undefined, ref.id);
          if (change !== undefined) {
            queued.change = change;
          }
          if (ref.url) {
            queued.url = ref.url;
          }
          result.push(queued);
        }
        aheadId = ahead.item_ahead;
      }
    }
    return result;
  }

  async listBuilds(tenant: string, opts: ListBuildsOptions = {}): Promise<Build[]> {
    this.logger?.info(
      `[Zuul] Listing builds for tenant="${tenant}" project="${opts.project ?? '*'}" change=${opts.change ?? '*'} patchset=${opts.patchset ?? '*'} (limit=${opts.limit ?? 50})`,
    );
    const raw = await this.withAuth(tenant, (headers) =>
      this.http.getJson<RawBuild[]>(
        this.tenantPath(tenant, '/builds'),
        {
          project: opts.project,
          change: opts.change,
          patchset: opts.patchset,
          limit: opts.limit ?? 50,
        },
        headers,
      ),
    );
    return raw.map(normalizeBuild);
  }

  async listBuildsets(tenant: string, opts: ListBuildsetsOptions = {}): Promise<Buildset[]> {
    this.logger?.info(
      `[Zuul] Listing buildsets for tenant="${tenant}" project="${opts.project ?? '*'}" change=${opts.change ?? '*'} patchset=${opts.patchset ?? '*'} (limit=${opts.limit ?? 10})`,
    );
    const raw = await this.withAuth(tenant, (headers) =>
      this.http.getJson<RawBuildset[]>(
        this.tenantPath(tenant, '/buildsets'),
        {
          project: opts.project,
          change: opts.change,
          patchset: opts.patchset,
          limit: opts.limit ?? 10,
        },
        headers,
      ),
    );
    return raw.map(normalizeBuildset);
  }

  async listJobs(tenant: string): Promise<ZuulJobSummary[]> {
    this.logger?.info(`[Zuul] Listing jobs for tenant="${tenant}"`);
    return this.cached(`jobs:${tenant}`, async () =>
      this.withAuth(tenant, (headers) =>
        this.http.getJson<ZuulJobSummary[]>(this.tenantPath(tenant, '/jobs'), undefined, headers),
      ),
    );
  }

  async getJob(tenant: string, name: string): Promise<ZuulJobVariant[]> {
    this.logger?.info(`[Zuul] Getting job "${name}" for tenant="${tenant}"`);
    const raw = await this.withAuth(tenant, (headers) =>
      this.http.getJson<ZuulJobVariant[] | ZuulJobVariant>(
        this.tenantPath(tenant, `/job/${encodeURIComponent(name)}`),
        undefined,
        headers,
      ),
    );
    return Array.isArray(raw) ? raw : [raw];
  }

  async listNodesets(tenant: string): Promise<ZuulNodeset[]> {
    this.logger?.info(`[Zuul] Listing nodesets for tenant="${tenant}"`);
    return this.cached(`nodesets:${tenant}`, async () =>
      this.withAuth(tenant, (headers) =>
        this.http.getJson<ZuulNodeset[]>(this.tenantPath(tenant, '/nodesets'), undefined, headers),
      ),
    );
  }

  async listProjectTemplates(tenant: string): Promise<ZuulProjectTemplate[]> {
    this.logger?.info(`[Zuul] Listing project templates for tenant="${tenant}"`);
    return this.cached(`projectTemplates:${tenant}`, async () => {
      try {
        const raw = await this.withAuth(tenant, (headers) =>
          this.http.getJson<(ZuulProjectTemplate | string)[]>(
            this.tenantPath(tenant, '/project-templates'),
            undefined,
            headers,
          ),
        );
        return raw.map((item) => (typeof item === 'string' ? { name: item } : item));
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          return [];
        }
        throw err;
      }
    });
  }

  async listSemaphores(tenant: string): Promise<ZuulSemaphore[]> {
    this.logger?.info(`[Zuul] Listing semaphores for tenant="${tenant}"`);
    return this.cached(`semaphores:${tenant}`, async () =>
      this.withAuth(tenant, (headers) =>
        this.http.getJson<ZuulSemaphore[]>(
          this.tenantPath(tenant, '/semaphores'),
          undefined,
          headers,
        ),
      ),
    );
  }

  async getProjectKey(tenant: string, project: string): Promise<string> {
    this.logger?.info(`[Zuul] Getting project key for tenant="${tenant}" project="${project}"`);
    const encodedProject = project.split('/').map(encodeURIComponent).join('/');
    return this.withAuth(tenant, (headers) =>
      this.http.getText(this.tenantPath(tenant, `/key/${encodedProject}.pub`), undefined, headers),
    );
  }

  async getInfo(tenant: string): Promise<ZuulInfo> {
    this.logger?.info(`[Zuul] Getting info for tenant="${tenant}"`);
    return this.withAuth(tenant, (headers) =>
      this.http.getJson<ZuulInfo>(this.tenantPath(tenant, '/info'), undefined, headers),
    );
  }
}
