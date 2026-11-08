import {
  type BranchMergeRules,
  type CheckRun,
  type CombinedStatus,
  type GheUser,
  type IssueComment,
  type PrRollup,
  type PullRequest,
  type RequiredStatusChecks,
  type Review,
  type SearchItem,
} from './gheTypes';
import { normalizeHost } from '../git/remoteUrl';
import { type Logger } from '../util/logger';
import { HttpClient, HttpError, type QueryParams } from './http';

const MAX_PAGINATION_PAGES = 10;
const PER_PAGE = 100;

const PR_ROLLUP_QUERY = `
query($owner: String!, $repo: String!, $num: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $num) {
      id
      isDraft
      mergeable
      reviewDecision
      labels(first: 50) {
        nodes {
          name
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on StatusContext {
                    context
                    state
                    isRequired(pullRequestNumber: $num)
                  }
                  ... on CheckRun {
                    name
                    conclusion
                    status
                    isRequired(pullRequestNumber: $num)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`.trim();

const REQUIRED_CONTEXTS_QUERY = `
query($owner: String!, $repo: String!, $qualifiedName: String!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $qualifiedName) {
      refUpdateRule {
        requiredStatusCheckContexts
      }
    }
  }
}
`.trim();

interface RequiredContextsData {
  repository?: {
    ref?: {
      refUpdateRule?: { requiredStatusCheckContexts?: (string | null)[] | null } | null;
    } | null;
  } | null;
}

const BRANCH_MERGE_RULES_QUERY = `
query($owner: String!, $repo: String!, $qualifiedName: String!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $qualifiedName) {
      refUpdateRule {
        requiredApprovingReviewCount
        requiresConversationResolution
        requiresSignatures
      }
    }
  }
}
`.trim();

interface BranchMergeRulesData {
  repository?: {
    ref?: {
      refUpdateRule?: {
        requiredApprovingReviewCount?: number | null;
        requiresConversationResolution?: boolean | null;
        requiresSignatures?: boolean | null;
      } | null;
    } | null;
  } | null;
}

function uniqueNames(names: readonly (string | null | undefined)[]): string[] {
  return Array.from(new Set(names.filter((n): n is string => Boolean(n))));
}

export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

export class GheClient {
  readonly host: string;
  readonly restBaseUrl: string;
  readonly graphqlUrl: string;
  private readonly http: HttpClient;
  private readonly logger?: Pick<Logger, 'info' | 'warn'>;

  constructor(
    host: string,
    getToken: () => Promise<string | undefined>,
    fetchFn?: typeof fetch,
    logger?: Pick<Logger, 'info' | 'warn'>,
  ) {
    const normalizedHost = normalizeHost(host);
    this.host = normalizedHost;
    this.logger = logger;
    if (normalizedHost === 'github.com') {
      this.restBaseUrl = 'https://api.github.com';
      this.graphqlUrl = 'https://api.github.com/graphql';
    } else {
      this.restBaseUrl = `https://${normalizedHost}/api/v3`;
      this.graphqlUrl = `https://${normalizedHost}/api/graphql`;
    }

    this.http = new HttpClient({
      baseUrl: this.restBaseUrl,
      getAuthHeader: async () => {
        const token = await getToken();
        return token ? `Bearer ${token}` : undefined;
      },
      fetchFn,
      logger: this.logger,
    });
  }

  async paginate<T>(
    initialPath: string,
    query?: QueryParams,
    maxPages = MAX_PAGINATION_PAGES,
  ): Promise<T[]> {
    const pages = await this.fetchPages<T[]>(initialPath, query, maxPages);
    return pages.flat();
  }

  /** Follows `Link: rel="next"` up to `maxPages` pages and logs when that limit cuts it short. */
  private async fetchPages<P>(
    initialPath: string,
    query?: QueryParams,
    maxPages = MAX_PAGINATION_PAGES,
  ): Promise<P[]> {
    const pages: P[] = [];
    let nextPath: string | undefined = initialPath;
    let nextQuery: QueryParams | undefined = query;

    while (nextPath && pages.length < maxPages) {
      const { data, headers } = await this.http.getJsonWithHeaders<P>(nextPath, nextQuery);
      pages.push(data);
      nextPath = parseNextLink(headers.get('link'));
      nextQuery = undefined;
    }

    if (nextPath) {
      this.logger?.warn(
        `[GHE] Stopped after ${maxPages} pages of ${initialPath}; the results are incomplete`,
      );
    }

    return pages;
  }

  async getUser(): Promise<GheUser> {
    return this.http.getJson<GheUser>('/user');
  }

  async findOpenPrForBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<PullRequest | undefined> {
    this.logger?.info(`[GHE] Finding open PR for owner=${owner} repo=${repo} branch=${branch}`);
    const prs = await this.http.getJson<PullRequest[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        state: 'open',
        head: `${owner}:${branch}`,
      },
    );
    const pr = prs[0];
    this.logger?.info(
      pr
        ? `[GHE] Found open PR #${pr.number} (head=${pr.head.sha}) for ${owner}/${repo} branch=${branch}`
        : `[GHE] No open PR found for ${owner}/${repo} branch=${branch}`,
    );
    return pr;
  }

  async getPr(owner: string, repo: string, num: number): Promise<PullRequest> {
    this.logger?.info(`[GHE] Fetching PR #${num} for ${owner}/${repo}`);
    return this.http.getJson<PullRequest>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${num}`,
    );
  }

  async updatePrBody(owner: string, repo: string, num: number, body: string): Promise<PullRequest> {
    this.logger?.info(`[GHE] Updating body of PR #${num} for ${owner}/${repo}`);
    return this.http.patchJson<PullRequest>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${num}`,
      { body },
    );
  }

  async listReviews(owner: string, repo: string, num: number): Promise<Review[]> {
    this.logger?.info(`[GHE] Listing reviews for PR #${num} on ${owner}/${repo}`);
    return this.paginate<Review>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${num}/reviews`,
    );
  }

  async listCommitStatuses(owner: string, repo: string, sha: string): Promise<CombinedStatus> {
    this.logger?.info(`[GHE] Listing commit statuses for commit=${sha} on ${owner}/${repo}`);
    const pages = await this.fetchPages<CombinedStatus>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/status`,
      { per_page: PER_PAGE },
    );
    const statuses = pages.flatMap((p) => p.statuses ?? []);
    return { ...pages[0], state: pages[0]?.state ?? 'pending', statuses };
  }

  async listCheckRuns(owner: string, repo: string, sha: string): Promise<CheckRun[]> {
    this.logger?.info(`[GHE] Listing check runs for commit=${sha} on ${owner}/${repo}`);
    const pages = await this.fetchPages<{ check_runs?: CheckRun[] } | CheckRun[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/check-runs`,
      { per_page: PER_PAGE },
    );
    return pages.flatMap((res) => (Array.isArray(res) ? res : (res.check_runs ?? [])));
  }

  async getRequiredStatusChecks(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<RequiredStatusChecks | undefined> {
    this.logger?.info(
      `[GHE] Querying required status checks for branch="${branch}" on ${owner}/${repo}`,
    );
    try {
      return await this.http.getJson<RequiredStatusChecks>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
        this.logger?.info(
          `[GHE] Required status checks returned ${err.status} for branch="${branch}" on ${owner}/${repo}`,
        );
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Names of the status checks the branch requires, or `undefined` when they can't be read.
   * Tries GraphQL `refUpdateRule` first (its own query, so an older GHE without the field only
   * fails here), then the REST branch protection endpoint.
   */
  async getRequiredContexts(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string[] | undefined> {
    try {
      const data = await this.http.graphql<RequiredContextsData>(
        this.graphqlUrl,
        REQUIRED_CONTEXTS_QUERY,
        { owner, repo, qualifiedName: `refs/heads/${branch}` },
      );
      const contexts = data.repository?.ref?.refUpdateRule?.requiredStatusCheckContexts;
      if (Array.isArray(contexts)) {
        return uniqueNames(contexts);
      }
    } catch {
      // Fall back to REST below.
    }

    const rest = await this.getRequiredStatusChecks(owner, repo, branch);
    if (!rest) {
      return undefined;
    }
    return uniqueNames([...(rest.contexts ?? []), ...(rest.checks ?? []).map((c) => c?.context)]);
  }

  /**
   * Branch rules besides status checks that can also make GHE report `blocked`, or `undefined` when
   * they can't be read. Its own query, so an older GHE without these fields only fails here.
   */
  async getBranchMergeRules(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<BranchMergeRules | undefined> {
    this.logger?.info(`[GHE] Querying merge rules for branch="${branch}" on ${owner}/${repo}`);
    try {
      const data = await this.http.graphql<BranchMergeRulesData>(
        this.graphqlUrl,
        BRANCH_MERGE_RULES_QUERY,
        { owner, repo, qualifiedName: `refs/heads/${branch}` },
      );
      const rule = data.repository?.ref?.refUpdateRule;
      if (
        typeof rule?.requiresConversationResolution !== 'boolean' ||
        typeof rule.requiresSignatures !== 'boolean'
      ) {
        return undefined;
      }
      return {
        requiredApprovingReviewCount: rule.requiredApprovingReviewCount ?? 0,
        requiresConversationResolution: rule.requiresConversationResolution,
        requiresSignatures: rule.requiresSignatures,
      };
    } catch (err) {
      this.logger?.info(
        `[GHE] Could not read merge rules for branch="${branch}" on ${owner}/${repo}: ${String(err)}`,
      );
      return undefined;
    }
  }

  async getPrRollup(owner: string, repo: string, num: number): Promise<PrRollup | undefined> {
    this.logger?.info(`[GHE] Querying PR rollup GraphQL for PR #${num} on ${owner}/${repo}`);
    try {
      const data = await this.http.graphql<{
        repository?: { pullRequest?: PrRollup | null } | null;
        pullRequest?: PrRollup | null;
      }>(this.graphqlUrl, PR_ROLLUP_QUERY, { owner, repo, num });
      return data.repository?.pullRequest ?? data.pullRequest ?? undefined;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw err;
      }
      this.logger?.warn(
        `[GHE] Failed to fetch PR rollup for PR #${num} on ${owner}/${repo}: ${String(err)}`,
      );
      return undefined;
    }
  }

  async postIssueComment(
    owner: string,
    repo: string,
    num: number,
    body: string,
  ): Promise<IssueComment> {
    this.logger?.info(`[GHE] Posting issue comment on PR #${num} for ${owner}/${repo}`);
    return this.http.postJson<IssueComment>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}/comments`,
      {
        body,
      },
    );
  }

  async searchPrs(query: string, perPage = 20): Promise<SearchItem[]> {
    this.logger?.info(`[GHE] Searching PRs with query="${query}"`);
    const q = /\bis:pr\b/.test(query) ? query : `${query} is:pr`;
    const res = await this.http.getJson<{ total_count?: number; items?: SearchItem[] }>(
      '/search/issues',
      { q, per_page: perPage },
    );
    return res.items ?? [];
  }
}
