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
