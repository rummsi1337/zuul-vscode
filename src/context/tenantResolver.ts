import { type ZuulClient } from '../clients/zuulClient';
import { type ZuulProject } from '../clients/zuulTypes';

export interface KeyValueStore {
  get(key: string): string | undefined;
  update(key: string, value: string): Thenable<void>;
}

export type TenantDiscoveryClient = Pick<ZuulClient, 'baseUrl' | 'listTenants' | 'listProjects'>;

export function tenantCacheKey(zuulUrl: string, project: string): string {
  return `tenant:${zuulUrl.replace(/\/+$/, '')}:${project}`;
}

function matchesProject(zuulProject: ZuulProject, project: string): boolean {
  if (zuulProject.name === project) {
    return true;
  }
  if (
    typeof zuulProject.canonical_name === 'string' &&
    zuulProject.canonical_name.endsWith(`/${project}`)
  ) {
    return true;
  }
  return false;
}

export async function resolveTenant(
  zuul: TenantDiscoveryClient,
  project: string,
  configured?: string,
  cache?: KeyValueStore,
): Promise<string | undefined> {
  const trimmedConfigured = configured?.trim();
  if (trimmedConfigured) {
    return trimmedConfigured;
  }

  const cacheKey = tenantCacheKey(zuul.baseUrl, project);
  const cached = cache?.get(cacheKey)?.trim();
  if (cached) {
    return cached;
  }

  const tenants = await zuul.listTenants();
  for (const tenant of tenants) {
    const projects = await zuul.listProjects(tenant.name);
    if (projects.some((p) => matchesProject(p, project))) {
      if (cache) {
        await cache.update(cacheKey, tenant.name);
      }
      return tenant.name;
    }
  }

  return undefined;
}
