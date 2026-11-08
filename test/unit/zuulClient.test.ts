import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/clients/http';
import {
  normalizeBuild,
  normalizeChangeStatus,
  normalizeJobStatus,
  ZuulClient,
} from '../../src/clients/zuulClient';
import buildsFixture from '../fixtures/zuul/builds.json';
import statusLegacyFixture from '../fixtures/zuul/status-legacy.json';
import statusModernFixture from '../fixtures/zuul/status-modern.json';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ZuulClient', () => {
  it('lists tenants and forwards optional Bearer token', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ name: 'acme', projects: 12, queue: 1 }, 'beta']));

    const client = new ZuulClient('https://zuul.example.com/', async () => 'zuul-token', fetchFn);
    expect(client.baseUrl).toBe('https://zuul.example.com');

    const tenants = await client.listTenants();
    expect(tenants).toEqual([{ name: 'acme', projects: 12, queue: 1 }, { name: 'beta' }]);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://zuul.example.com/api/tenants',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer zuul-token',
        }),
      }),
    );
  });

  it('normalises legacy getChangeStatus items including item_ahead and items_ahead deduplication', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(statusLegacyFixture));
    const client = new ZuulClient('https://zuul.example.com', undefined, fetchFn);

    const statuses = await client.getChangeStatus('acme', 42, '9f8e7d6c5b4a3210');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://zuul.example.com/api/tenant/acme/status/change/42,9f8e7d6c5b4a3210',
      expect.anything(),
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({
      pipeline: 'check',
      queue: 'shared',
      live: true,
      enqueueTime: 1700000000000,
      remainingTimeMs: 120000,
      itemsAhead: [
        {
          project: 'acme/common-lib',
          change: 89,
          live: false,
          url: 'https://ghe.example.com/acme/common-lib/pull/89',
        },
        {
          project: 'acme/core',
          change: 90,
          live: true,
          url: 'https://ghe.example.com/acme/core/pull/90',
        },
      ],
      jobs: [
        {
          name: 'zuul-tox-linters',
          uuid: '11111111-2222-3333-4444-555555555555',
          result: 'SUCCESS',
          running: false,
          elapsedMs: 45000,
          remainingMs: 0,
          reportUrl: 'https://logs.example.com/42/9f8e7d6c5b4a3210/check/zuul-tox-linters/1111111/',
        },
        {
          name: 'zuul-tox-py311',
          uuid: '66666666-7777-8888-9999-000000000000',
          running: true,
          elapsedMs: 30000,
          remainingMs: 90000,
          streamUrl: 'stream/66666666-7777-8888-9999-000000000000',
        },
        {
          name: 'zuul-deploy-preview',
          running: false,
        },
      ],
    });
  });

  it('normalises modern getChangeStatus items with refs[] into itemsAhead (live: false)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(statusModernFixture));
    const client = new ZuulClient('https://zuul.example.com', undefined, fetchFn);

    const statuses = await client.getChangeStatus('acme', 42, '9f8e7d6c5b4a3210');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({
      pipeline: 'check',
      queue: 'shared',
      live: true,
      enqueueTime: 1700000000000,
      remainingTimeMs: 120000,
      itemsAhead: [
        {
          project: 'ghe.example.com/acme/common-lib',
          change: 89,
          live: false,
          url: 'https://ghe.example.com/acme/common-lib/pull/89',
        },
      ],
      jobs: [
        {
          name: 'zuul-tox-linters',
          uuid: '11111111-2222-3333-4444-555555555555',
          result: 'FAILURE',
          running: false,
          elapsedMs: 52000,
          remainingMs: 0,
          reportUrl: 'https://logs.example.com/42/9f8e7d6c5b4a3210/check/zuul-tox-linters/1111111/',
        },
      ],
    });
  });

  it('returns empty array on 404 from getChangeStatus and rethrows non-404 errors', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const client = new ZuulClient('https://zuul.example.com', undefined, fetchFn);

    expect(await client.getChangeStatus('acme', 42, 'deadbeef')).toEqual([]);
    await expect(client.getChangeStatus('acme', 42, 'deadbeef')).rejects.toThrowError(HttpError);
  });

  it('maps both flat build fields and nested ref objects in listBuilds and listBuildsets', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(buildsFixture))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            uuid: 'bs-1',
            result: 'SUCCESS',
            pipeline: 'check',
            ref: { project: 'acme/service', change: '42', patchset: '9f8e7d6c5b4a3210' },
            builds: [buildsFixture[0]],
          },
        ]),
      );

    const client = new ZuulClient('https://zuul.example.com', undefined, fetchFn);

    const builds = await client.listBuilds('acme', {
      project: 'acme/service',
      change: 42,
      patchset: '9f8e7d6c5b4a3210',
    });

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://zuul.example.com/api/tenant/acme/builds?project=acme%2Fservice&change=42&patchset=9f8e7d6c5b4a3210&limit=50',
      expect.anything(),
    );
    expect(builds).toEqual([
      {
        uuid: 'b1111111-2222-3333-4444-555555555555',
        jobName: 'zuul-tox-linters',
        result: 'SUCCESS',
        pipeline: 'check',
        logUrl: 'https://logs.example.com/42/9f8e7d6c5b4a3210/check/zuul-tox-linters/b111111/',
        startTime: '2026-11-07T18:00:00',
        endTime: '2026-11-07T18:01:30',
        project: 'acme/service',
        change: 42,
        patchset: '9f8e7d6c5b4a3210',
        artifacts: [
          {
            name: 'Coverage Report',
            url: 'https://logs.example.com/42/9f8e7d6c5b4a3210/check/zuul-tox-linters/b111111/coverage/index.html',
          },
        ],
      },
      {
        uuid: 'b2222222-3333-4444-5555-666666666666',
        jobName: 'zuul-tox-py311',
        result: 'FAILURE',
        pipeline: 'check',
        logUrl: 'https://logs.example.com/42/9f8e7d6c5b4a3210/check/zuul-tox-py311/b222222/',
        startTime: '2026-11-07T18:00:05',
        endTime: '2026-11-07T18:04:10',
        project: 'acme/service',
        change: 42,
        patchset: '9f8e7d6c5b4a3210',
        artifacts: [],
      },
    ]);

    const buildsets = await client.listBuildsets('acme', {
      project: 'acme/service',
      change: 42,
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://zuul.example.com/api/tenant/acme/buildsets?project=acme%2Fservice&change=42&limit=10',
      expect.anything(),
    );
    expect(buildsets).toHaveLength(1);
    expect(buildsets[0]?.uuid).toBe('bs-1');
    expect(buildsets[0]?.change).toBe(42);
    expect(buildsets[0]?.builds).toHaveLength(1);
  });

  it('caches tenant metadata for 5 minutes and respects expiry and clearCache()', async () => {
    let clock = 1_000_000;
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/projects')) {
        return jsonResponse([{ name: 'acme/service', canonical_name: 'ghe/acme/service' }]);
      }
      if (url.endsWith('/jobs')) {
        return jsonResponse([{ name: 'base' }, { name: 'tox-linters' }]);
      }
      if (url.endsWith('/nodesets')) {
        return jsonResponse([{ name: 'ubuntu-jammy' }]);
      }
      if (url.endsWith('/project-templates')) {
        return jsonResponse([{ name: 'python-jobs' }, 'docker-jobs']);
      }
      if (url.endsWith('/semaphores')) {
        return jsonResponse([{ name: 'deploy-lock', max: 1 }]);
      }
      return new Response('Not Found', { status: 404 });
    });

    const client = new ZuulClient('https://zuul.example.com', undefined, fetchFn, () => clock);

    // Initial fetches populate cache
    expect(await client.listProjects('acme')).toEqual([
      { name: 'acme/service', canonical_name: 'ghe/acme/service' },
    ]);
    expect(await client.listJobs('acme')).toEqual([{ name: 'base' }, { name: 'tox-linters' }]);
    expect(await client.listNodesets('acme')).toEqual([{ name: 'ubuntu-jammy' }]);
    expect(await client.listProjectTemplates('acme')).toEqual([
      { name: 'python-jobs' },
      { name: 'docker-jobs' },
    ]);
    expect(await client.listSemaphores('acme')).toEqual([{ name: 'deploy-lock', max: 1 }]);
    expect(fetchFn).toHaveBeenCalledTimes(5);

    // Within 5 min TTL: all 5 hit cache
    clock += 4 * 60 * 1000;
    await client.listProjects('acme');
    await client.listJobs('acme');
    await client.listNodesets('acme');
    await client.listProjectTemplates('acme');
    await client.listSemaphores('acme');
    expect(fetchFn).toHaveBeenCalledTimes(5);

    // Different tenant does not share cache
    await client.listJobs('other-tenant');
    expect(fetchFn).toHaveBeenCalledTimes(6);

    // After 5 min TTL expires: re-fetches
    clock += 60 * 1000 + 1;
    await client.listJobs('acme');
    expect(fetchFn).toHaveBeenCalledTimes(7);

    // clearCache forces immediate re-fetch
    client.clearCache();
    await client.listJobs('acme');
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });

  it('handles 404 on listProjectTemplates by returning [] and rethrows non-404 errors', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));

    const client = new ZuulClient('https://zuul.example.com', undefined, fetchFn);

    expect(await client.listProjectTemplates('acme')).toEqual([]);
    // Cached [] on second call for same tenant
    expect(await client.listProjectTemplates('acme')).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await expect(client.listProjectTemplates('failing-tenant')).rejects.toThrowError(HttpError);
  });

  it('fetches job variants, project public key without encoding slash, and tenant info', async () => {
    const publicKeyPem = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...\n-----END PUBLIC KEY-----\n';
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ name: 'tox-linters', parent: 'base', timeout: 1800 }]))
      .mockResolvedValueOnce(jsonResponse({ name: 'single-job', parent: null }))
      .mockResolvedValueOnce(new Response(publicKeyPem, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ info: { tenant: 'acme' } }));

    const client = new ZuulClient('https://zuul.example.com', undefined, fetchFn);

    const variants = await client.getJob('acme', 'tox-linters');
    expect(variants).toEqual([{ name: 'tox-linters', parent: 'base', timeout: 1800 }]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://zuul.example.com/api/tenant/acme/job/tox-linters',
      expect.anything(),
    );

    const singleVariant = await client.getJob('acme', 'single-job');
    expect(singleVariant).toEqual([{ name: 'single-job', parent: null }]);

    const key = await client.getProjectKey('acme', 'org/repo');
    expect(key).toBe(publicKeyPem);
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      'https://zuul.example.com/api/tenant/acme/key/org/repo.pub',
      expect.anything(),
    );

    const info = await client.getInfo('acme');
    expect(info).toEqual({ info: { tenant: 'acme' } });
    expect(fetchFn).toHaveBeenNthCalledWith(
      4,
      'https://zuul.example.com/api/tenant/acme/info',
      expect.anything(),
    );
  });

  it('normalises sparse objects and optional fields in normalisers and getToken', async () => {
    expect(normalizeJobStatus({ running: true, stream_url: 'ws://stream' })).toEqual({
      name: '',
      running: true,
      streamUrl: 'ws://stream',
    });
    expect(normalizeJobStatus({ uuid: 'u1' })).toEqual({
      name: '',
      uuid: 'u1',
      running: true,
    });
    expect(normalizeChangeStatus({ item_ahead: { id: 'not-a-num', project: 'p' } })).toEqual({
      pipeline: '',
      queue: '',
      live: true,
      jobs: [],
      itemsAhead: [{ project: 'p', live: false }],
    });
    expect(
      normalizeBuild({
        job_name: 'alt-job',
        log_url: 'https://logs.example.com/alt',
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-01-01T00:01:00Z',
        change: 'not-a-num',
        artifacts: [{}],
      }),
    ).toEqual({
      uuid: '',
      jobName: 'alt-job',
      pipeline: '',
      logUrl: 'https://logs.example.com/alt',
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-01-01T00:01:00Z',
      artifacts: [{ name: '', url: '' }],
    });

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ uuid: 'bs-empty' }]));
    const client = new ZuulClient('https://zuul.example.com', async () => undefined, fetchFn);
    expect(await client.listBuilds('acme')).toEqual([]);
    expect(await client.listBuildsets('acme')).toEqual([{ uuid: 'bs-empty', pipeline: '' }]);
  });
});
