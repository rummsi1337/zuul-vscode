export interface GheUser {
  login: string;
  name?: string | null;
  id?: number;
}

export interface PullRequest {
  number: number;
  html_url: string;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable_state?: string;
  body: string | null;
  updated_at?: string;
  head: {
    sha: string;
    ref: string;
    repo: {
      full_name: string;
    };
  };
  base: {
    ref: string;
    repo: {
      full_name: string;
    };
  };
  user: {
    login: string;
  };
  labels: {
    name: string;
  }[];
}

export interface Review {
  id: number;
  user: {
    login: string;
  } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | string;
  submitted_at?: string;
}

export interface CommitStatus {
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success' | string;
  description?: string | null;
  target_url?: string | null;
}

export interface CombinedStatus {
  state: 'error' | 'failure' | 'pending' | 'success' | string;
  statuses: CommitStatus[];
}

export interface CheckRun {
  id?: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'startup_failure'
    | 'stale'
    | null
    | string;
  html_url?: string | null;
}

export interface RequiredStatusChecks {
  strict?: boolean;
  contexts: string[];
  checks?: {
    context: string;
    app_id?: number | null;
  }[];
}

export interface RollupStatusContextNode {
  __typename: 'StatusContext';
  context: string;
  state: string;
  isRequired: boolean;
}

export interface RollupCheckRunNode {
  __typename: 'CheckRun';
  name: string;
  conclusion: string | null;
  status: string;
  isRequired: boolean;
}

export type RollupContextNode = RollupStatusContextNode | RollupCheckRunNode;

export interface PrRollup {
  id: string;
  isDraft: boolean;
  mergeable?: string;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  labels: {
    nodes: {
      name: string;
    }[];
  };
  commits: {
    nodes: {
      commit: {
        oid: string;
        statusCheckRollup: {
          state: string;
          contexts: {
            nodes: RollupContextNode[];
          };
        } | null;
      };
    }[];
  };
}

export interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed' | string;
  draft?: boolean;
  body?: string | null;
  user?: {
    login: string;
  } | null;
  repository_url?: string;
  pull_request?: {
    url?: string;
    html_url?: string;
    merged_at?: string | null;
  };
  labels?: {
    name: string;
  }[];
}

export interface IssueComment {
  id: number;
  html_url?: string;
  body: string;
}
