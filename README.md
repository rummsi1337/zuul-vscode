# Zuul CI for VS Code

VS Code extension that shows [Zuul CI](https://zuul-ci.org) builds, `Depends-On` links and gate readiness for the current GitHub Enterprise pull request.

> **Experimental, work in progress.** Not ready for production use. Expect bugs and breaking changes.

## Build and install

```sh
npm install
npm run build
npm run package
code --install-extension zuul-vscode-0.0.1.vsix
```

Or in VS Code: Extensions view → `…` menu → **Install from VSIX…**

## Authentication

The extension talks to GitHub Enterprise and to Zuul, and each needs its own credentials. Tokens you paste into VS Code are kept in its secret storage (backed by the OS keychain), not in settings files.

### GitHub Enterprise

Choose how the extension signs in with `zuul.auth.method`:

| Value           | What it does                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `pat` (default) | Uses a Personal Access Token (PAT) stored in VS Code.                                                   |
| `gh-cli`        | Runs `gh auth token --hostname <host>` and keeps the result in memory for 5 minutes. Nothing is stored. |
| `auto`          | Tries the stored PAT first, then `gh`.                                                                  |
| `oauth`         | Not implemented yet. With this value the extension finds no token.                                      |

To use a PAT:

1. Create a PAT with the `repo` scope on your GitHub Enterprise server. The extension reads pull requests, posts trigger comments and edits `Depends-On` lines in pull request descriptions.
2. Run **Zuul: Set GitHub Enterprise PAT** and paste it. The token is checked against the server before it is saved.

To use the `gh` CLI, run `gh auth login --hostname <host>` first.

Good to know:

- Each host has its own PAT. The host comes from the git remote. Set `zuul.ghe.host` to override it.
- Run **Zuul: Clear GitHub Enterprise PAT** to remove a PAT.
- If the server answers 401, the stored PAT is kept and one **Sign in** prompt appears per token. Replacing or clearing the PAT is up to you.

### Zuul

Set `zuul.url` to the base URL of Zuul Web, including any path prefix, for example `https://example.com/zuul`. Set `zuul.tenant`, or leave it empty to auto-detect the tenant from the repository.

Zuul tokens are read-only and belong to one tenant. Copy yours from the Zuul web UI. Tenants that allow anonymous read access don't need a token.

There are three ways to provide a token:

| Way                             | Use it for                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Zuul: Set Zuul Tenant Token** | Pasting a token, or the path to a token file. Enter `*` as the tenant to use it for every tenant.     |
| `zuul.tokens`                   | One token file per tenant, keyed by tenant name or `*`. File paths only: raw tokens here are ignored. |
| `zuul.tokenFile`                | One token file for all tenants.                                                                       |

Example user settings:

```json
{
  "zuul.url": "https://example.com/zuul",
  "zuul.tokens": {
    "ddad": "~/.zuul/ddad.token",
    "swh": "~/.zuul/swh.token"
  }
}
```

A token file holds either the token alone, or a JSON object that maps tenants to tokens:

```json
{ "ddad": "eyJ...", "swh": "eyJ...", "*": "eyJ..." }
```

From a JSON file, the extension uses the tenant's entry, then `*`, then the only token if the file has exactly one. Paths must be absolute or start with `~/`. Files are read on every request, so replacing a file takes effect right away.

For each tenant, the first match wins:

1. The token stored for that tenant
2. `zuul.tokens["<tenant>"]`
3. The token stored for `*`
4. `zuul.tokens["*"]`
5. `zuul.tokenFile`

If none of these match, the tokens of your other tenants are tried in turn, in case one token has access to several tenants. When Zuul refuses one with 401 or 403, the next is tried. The one that worked is tried first from then on.

Tokens expire. When Zuul refuses a token, a popup with a **Set Zuul Token** button appears, once per tenant until the token changes.

Run **Zuul: Clear Zuul Tenant Token** to choose a stored token to remove. This doesn't change `zuul.tokens` or `zuul.tokenFile`.

`zuul.url`, `zuul.tokens` and `zuul.tokenFile` only work from user settings and are ignored in a repository's `.vscode/settings.json`. This stops a repository from sending your tokens to another server or reading your local files. Use an `https://` URL, because `http://` sends tokens unencrypted.

## Development

```sh
npm install
npm test
```

Press `F5` in VS Code to launch the extension in a development host.

## Releases

Built `.vsix` files are published on the [Releases page](https://github.com/rummsi1337/zuul-vscode/releases). Install one with `code --install-extension zuul-vscode-<version>.vsix`.

| Trigger           | Version       | Published as |
| ----------------- | ------------- | ------------ |
| Merge to `main`   | `1.2.4-pre.3` | Pre-release  |
| Push tag `v1.3.0` | `1.3.0`       | Release      |

A pre-release version is the next patch after the latest release tag, plus the number of merges since that tag. For example, `1.2.4-pre.3` is the third merge after `v1.2.3`.

To publish a release, tag a commit on `main`. The tag must be exactly `vX.Y.Z`:

```sh
git switch main
git pull
git tag v1.3.0
git push origin v1.3.0
```

Git tags are the only source of truth for the version. CI stamps the version into `package.json` at build time and never commits it, so the `version` in the repository is a placeholder.

## License

[MIT](LICENSE)
