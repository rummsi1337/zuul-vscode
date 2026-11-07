import {
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
import { HttpClient, HttpError, type QueryParams } from './http';

const MAX_PAGINATION_PAGES = 10;

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

  constructor(host: string, getToken: () => Promise<string | undefined>, fetchFn?: typeof fetch) {
    const normalizedHost = host.trim().toLowerCase();
    this.host = normalizedHost;
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
    });
  }

  async paginate<T>(
    initialPath: string,
    query?: QueryParams,
    maxPages = MAX_PAGINATION_PAGES,
  ): Promise<T[]> {
    const results: T[] = [];
    let nextPath: string | undefined = initialPath;
    let nextQuery: QueryParams | undefined = query;
    let page = 0;

    while (nextPath && page < maxPages) {
      page += 1;
      const { data, headers } = await this.http.getJsonWithHeaders<T[]>(nextPath, nextQuery);
      results.push(...data);
      nextPath = parseNextLink(headers.get('link'));
      nextQuery = undefined;
    }

    return results;
  }

  async getUser(): Promise<GheUser> {
    return this.http.getJson<GheUser>('/user');
  }

  async findOpenPrForBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<PullRequest | undefined> {
    const prs = await this.http.getJson<PullRequest[]>(`/repos/${owner}/${repo}/pulls`, {
      state: 'open',
      head: `${owner}:${branch}`,
    });
    return prs[0];
  }

  async getPr(owner: string, repo: string, num: number): Promise<PullRequest> {
    return this.http.getJson<PullRequest>(`/repos/${owner}/${repo}/pulls/${num}`);
  }

  async updatePrBody(owner: string, repo: string, num: number, body: string): Promise<PullRequest> {
    return this.http.patchJson<PullRequest>(`/repos/${owner}/${repo}/pulls/${num}`, { body });
  }

  async listReviews(owner: string, repo: string, num: number): Promise<Review[]> {
    return this.paginate<Review>(`/repos/${owner}/${repo}/pulls/${num}/reviews`);
  }

  async listCommitStatuses(owner: string, repo: string, sha: string): Promise<CombinedStatus> {
    return this.http.getJson<CombinedStatus>(`/repos/${owner}/${repo}/commits/${sha}/status`);
  }

  async listCheckRuns(owner: string, repo: string, sha: string): Promise<CheckRun[]> {
    const res = await this.http.getJson<{ check_runs?: CheckRun[] } | CheckRun[]>(
      `/repos/${owner}/${repo}/commits/${sha}/check-runs`,
    );
    return Array.isArray(res) ? res : (res.check_runs ?? []);
  }

  async getRequiredStatusChecks(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<RequiredStatusChecks | undefined> {
    try {
      return await this.http.getJson<RequiredStatusChecks>(
        `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
        return undefined;
      }
      throw err;
    }
  }

  async getPrRollup(owner: string, repo: string, num: number): Promise<PrRollup | undefined> {
    try {
      const data = await this.http.graphql<{
        repository?: { pullRequest?: PrRollup | null } | null;
        pullRequest?: PrRollup | null;
      }>(this.graphqlUrl, PR_ROLLUP_QUERY, { owner, repo, num });
      return data.repository?.pullRequest ?? data.pullRequest ?? undefined;
    } catch {
      return undefined;
    }
  }

  async postIssueComment(
    owner: string,
    repo: string,
    num: number,
    body: string,
  ): Promise<IssueComment> {
    return this.http.postJson<IssueComment>(`/repos/${owner}/${repo}/issues/${num}/comments`, {
      body,
    });
  }

  async searchPrs(query: string, perPage = 20): Promise<SearchItem[]> {
    const q = /\bis:pr\b/.test(query) ? query : `${query} is:pr`;
    const res = await this.http.getJson<{ total_count?: number; items?: SearchItem[] }>(
      '/search/issues',
      { q, per_page: perPage },
    );
    return res.items ?? [];
  }
}
