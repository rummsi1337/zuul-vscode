import { type GheClient } from '../../src/clients/gheClient';
import { type ZuulClient } from '../../src/clients/zuulClient';
import { type ResolvedContext } from '../../src/context/zuulContext';

export function makeResolvedContext(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    repoRoot: '/workspace/service',
    host: 'ghe.example.com',
    owner: 'acme',
    repo: 'service',
    branch: 'feat/x',
    headSha: 'local-head-sha-ignored',
    zuulUrl: 'https://zuul.example.com',
    tenant: 'main',
    project: 'acme/service',
    ghe: {} as unknown as GheClient,
    zuul: {} as unknown as ZuulClient,
    ...overrides,
  };
}
