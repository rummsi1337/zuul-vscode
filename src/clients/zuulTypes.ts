export interface ChangeStatus {
  pipeline: string;
  queue: string;
  live: boolean;
  enqueueTime?: number;
  remainingTimeMs?: number;
  jobs: JobStatus[];
  itemsAhead: QueuedRef[];
}

export interface JobStatus {
  name: string;
  uuid?: string;
  result?: string;
  running: boolean;
  elapsedMs?: number;
  remainingMs?: number;
  streamUrl?: string;
  reportUrl?: string;
}

export interface QueuedRef {
  project: string;
  change?: number;
  live: boolean;
  url?: string;
}

export interface BuildArtifact {
  name: string;
  url: string;
}

export interface Build {
  uuid: string;
  jobName: string;
  result?: string;
  pipeline: string;
  logUrl?: string;
  startTime?: string;
  endTime?: string;
  project?: string;
  change?: number;
  patchset?: string;
  artifacts: BuildArtifact[];
}

export interface Buildset {
  uuid: string;
  result?: string;
  pipeline: string;
  project?: string;
  change?: number;
  patchset?: string;
  builds?: Build[];
}

export interface ZuulTenant {
  name: string;
  projects?: number;
  queue?: number;
}

export interface ZuulProject {
  name: string;
  canonical_name?: string;
  connection_name?: string;
  type?: string;
}

export interface ZuulSourceContext {
  project?: string;
  branch?: string;
  path?: string;
}

export interface ZuulJobSummary {
  name: string;
  description?: string;
  parent?: string | null;
  source_context?: ZuulSourceContext;
  variants?: {
    parent?: string | null;
    description?: string;
    source_context?: ZuulSourceContext;
  }[];
}

export interface ZuulPlaybookRef {
  path: string;
  roles?: unknown[];
  secrets?: unknown[];
  semaphores?: unknown[];
}

export interface ZuulJobVariant {
  name: string;
  parent?: string | null;
  description?: string;
  abstract?: boolean;
  final?: boolean;
  protected?: boolean;
  voting?: boolean;
  timeout?: number;
  post_timeout?: number;
  attempts?: number;
  pre_run?: (ZuulPlaybookRef | string)[];
  run?: (ZuulPlaybookRef | string)[];
  post_run?: (ZuulPlaybookRef | string)[];
  cleanup_run?: (ZuulPlaybookRef | string)[];
  variables?: Record<string, unknown>;
  host_variables?: Record<string, Record<string, unknown>>;
  group_variables?: Record<string, Record<string, unknown>>;
  roles?: { zuul?: string; name?: string; target_name?: string }[];
  required_projects?: (
    string | { project_name?: string; name?: string; override_checkout?: string }
  )[];
  nodeset?: string | { name?: string; nodes?: unknown[]; groups?: unknown[] };
  files?: string[];
  irrelevant_files?: string[];
  branches?: string[];
  dependencies?: (string | { name: string; soft?: boolean })[];
  semaphores?: (string | { name: string; resources_first?: boolean })[];
  source_context?: ZuulSourceContext;
}

export interface ZuulNodeset {
  name: string;
  nodes?: { name: string; label: string | string[] }[];
  groups?: { name: string; nodes: string[] }[];
  alternatives?: unknown[];
  source_context?: ZuulSourceContext;
}

export interface ZuulProjectTemplate {
  name: string;
  description?: string;
  source_context?: ZuulSourceContext;
}

export interface ZuulSemaphore {
  name: string;
  max?: number;
  global?: boolean;
  source_context?: ZuulSourceContext;
}

export interface ZuulInfo {
  info?: {
    tenant?: string;
    websocket_url?: string;
    capabilities?: Record<string, unknown>;
  };
  tenant?: string;
  websocket_url?: string;
  capabilities?: Record<string, unknown>;
}

export interface ListBuildsOptions {
  project?: string;
  change?: number | string;
  patchset?: string;
  limit?: number;
}

export interface ListBuildsetsOptions {
  project?: string;
  change?: number | string;
  patchset?: string;
  limit?: number;
}
