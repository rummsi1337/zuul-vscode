import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/clients/http';
import {
  type KeyValueStore,
  resolveTenant,
  tenantCacheKey,
  type TenantDiscoveryClient,
} from '../../src/context/tenantResolver';

function createMemoryCache(initial: Record<string, string> = {}): KeyValueStore & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn((key: string) => store.get(key)),
    update: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

describe('resolveTenant', () => {
  it('returns configured tenant immediately without querying cache or Zuul API', async () => {
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(),
      listProjects: vi.fn(),
    };
    const cache = createMemoryCache();

    const result = await resolveTenant(zuul, 'acme/service', '  corp-tenant  ', cache);

    expect(result).toBe('corp-tenant');
    expect(cache.get).not.toHaveBeenCalled();
    expect(zuul.listTenants).not.toHaveBeenCalled();
    expect(zuul.listProjects).not.toHaveBeenCalled();
  });

  it('returns cached tenant on cache hit without querying Zuul API', async () => {
    const key = tenantCacheKey('https://zuul.example.com/', 'acme/service');
    expect(key).toBe('tenant:https://zuul.example.com:acme/service');

    const cache = createMemoryCache({ [key]: 'cached-tenant' });
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(),
      listProjects: vi.fn(),
    };

    const result = await resolveTenant(zuul, 'acme/service', '   ', cache);

    expect(result).toBe('cached-tenant');
    expect(cache.get).toHaveBeenCalledWith('tenant:https://zuul.example.com:acme/service');
    expect(zuul.listTenants).not.toHaveBeenCalled();
  });

  it('discovers tenant sequentially by project name and caches the first match', async () => {
    const callOrder: string[] = [];
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]),
      listProjects: vi.fn(async (tenant: string) => {
        callOrder.push(tenant);
        if (tenant === 'alpha') {
          return [{ name: 'other/repo' }];
        }
        if (tenant === 'beta') {
          return [{ name: 'acme/service' }];
        }
        return [{ name: 'acme/service' }];
      }),
    };
    const cache = createMemoryCache();

    const result = await resolveTenant(zuul, 'acme/service', undefined, cache);

    expect(result).toBe('beta');
    expect(callOrder).toEqual(['alpha', 'beta']);
    expect(cache.store.get('tenant:https://zuul.example.com:acme/service')).toBe('beta');
  });

  it('discovers tenant by canonical_name ending with /<owner/repo>', async () => {
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'first' }, { name: 'second' }]),
      listProjects: vi.fn(async (tenant: string) => {
        if (tenant === 'first') {
          return [
            {
              name: 'wrong',
              canonical_name: 'ghe.example.com/not-acme/service',
            },
          ];
        }
        return [
          {
            name: 'internal-id',
            canonical_name: 'ghe.example.com/acme/service',
          },
        ];
      }),
    };
    const cache = createMemoryCache();

    const result = await resolveTenant(zuul, 'acme/service', '', cache);

    expect(result).toBe('second');
    expect(cache.store.get('tenant:https://zuul.example.com:acme/service')).toBe('second');
  });

  it('returns undefined and does not write cache when no tenant contains the project', async () => {
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'alpha' }, { name: 'beta' }]),
      listProjects: vi.fn(async () => [{ name: 'other/repo', canonical_name: 'ghe/other/repo' }]),
    };
    const cache = createMemoryCache();

    const result = await resolveTenant(zuul, 'acme/missing', undefined, cache);

    expect(result).toBeUndefined();
    expect(cache.update).not.toHaveBeenCalled();
  });

  it('skips a forbidden tenant and still finds the project in the next one', async () => {
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'alpha' }, { name: 'beta' }]),
      listProjects: vi.fn(async (tenant: string) => {
        if (tenant === 'alpha') {
          throw new HttpError(403, 'Forbidden');
        }
        return [{ name: 'acme/service' }];
      }),
    };

    await expect(resolveTenant(zuul, 'acme/service')).resolves.toBe('beta');
  });

  it('rejects with HttpError when all tenants are forbidden', async () => {
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'alpha' }, { name: 'beta' }]),
      listProjects: vi.fn(async () => {
        throw new HttpError(403, 'Forbidden');
      }),
    };

    await expect(resolveTenant(zuul, 'acme/service')).rejects.toBeInstanceOf(HttpError);
  });

  it('propagates non-auth errors', async () => {
    const zuul: TenantDiscoveryClient = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'alpha' }, { name: 'beta' }]),
      listProjects: vi.fn(async () => {
        throw new HttpError(500, 'Server error');
      }),
    };

    await expect(resolveTenant(zuul, 'acme/service')).rejects.toMatchObject({ status: 500 });
    expect(zuul.listProjects).toHaveBeenCalledTimes(1);
  });
});
