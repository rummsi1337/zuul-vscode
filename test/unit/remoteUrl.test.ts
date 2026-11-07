import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../../src/git/remoteUrl';

describe('parseRemoteUrl', () => {
  it('parses SCP-style git@host:owner/repo URLs with and without .git suffix', () => {
    expect(parseRemoteUrl('git@github.com:zuul/zuul-vscode.git')).toEqual({
      host: 'github.com',
      owner: 'zuul',
      repo: 'zuul-vscode',
    });

    expect(parseRemoteUrl('git@ghe.example.com:acme/service')).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'service',
    });

    expect(parseRemoteUrl('git@ghe.example.com:acme/my.dotted.repo.git')).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'my.dotted.repo',
    });
  });

  it('parses ssh://git@host(:port)/owner/repo(.git) URLs and strips port', () => {
    expect(parseRemoteUrl('ssh://git@ghe.example.com/acme/app.git')).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'app',
    });

    expect(parseRemoteUrl('ssh://git@ghe.example.com:2222/acme/app.git')).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'app',
    });

    expect(parseRemoteUrl('ssh://git@ghe.example.com:29418/acme/app')).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'app',
    });
  });

  it('parses https://(user@)host(:port)/owner/repo(.git)(/) URLs', () => {
    expect(parseRemoteUrl('https://github.com/owner/repo')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });

    expect(parseRemoteUrl('https://github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });

    expect(parseRemoteUrl('https://github.com/owner/repo.git/')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });

    expect(parseRemoteUrl('https://github.com/owner/repo/')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });

    expect(parseRemoteUrl('https://alice@ghe.example.com:8443/acme/platform.git/')).toEqual({
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'platform',
    });

    expect(parseRemoteUrl('http://127.0.0.1:43210/acme/app')).toEqual({
      host: '127.0.0.1',
      owner: 'acme',
      repo: 'app',
    });
  });

  it('normalizes host to lowercase while preserving owner and repo case', () => {
    expect(parseRemoteUrl('git@GHE.Corp.Example.COM:MyOrg/MyRepo.git')).toEqual({
      host: 'ghe.corp.example.com',
      owner: 'MyOrg',
      repo: 'MyRepo',
    });

    expect(parseRemoteUrl('https://Git.Example.COM:8443/MyOrg/MyRepo.git/')).toEqual({
      host: 'git.example.com',
      owner: 'MyOrg',
      repo: 'MyRepo',
    });
  });

  it('returns undefined for invalid or unsupported remote URLs', () => {
    const invalidUrls = [
      '',
      'not-a-url',
      'ftp://github.com/owner/repo.git',
      'git://github.com/owner/repo.git',
      'file:///path/to/repo.git',
      'user@github.com:owner/repo.git',
      'git@github.com:onlyrepo.git',
      'git@github.com:owner/repo/extra.git',
      'git@github.com:/owner/repo.git',
      'git@github.com:owner/.git',
      'https://github.com/onlyowner',
      'https://github.com/owner/repo/subpath',
      'https://github.com:0/owner/repo',
      'https://github.com:65536/owner/repo',
      'https://github.com:abc/owner/repo',
      'https://github.com:/owner/repo',
      'https://github.com/owner/.git',
      'https://github.com/./repo',
      'https://github.com/owner/..',
      'https://github.com/owner/repo?ref=main',
      'https://github.com/owner/repo#readme',
    ];

    for (const url of invalidUrls) {
      expect(parseRemoteUrl(url), `expected undefined for ${url}`).toBeUndefined();
    }
  });
});
