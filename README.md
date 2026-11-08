# Zuul CI for VS Code

VS Code extension that shows [Zuul CI](https://zuul-ci.org) builds, `Depends-On` links and gate readiness for the current GitHub Enterprise pull request.

> **Experimental, work in progress.** Not ready for production use. Expect bugs and breaking changes.

## Build and install

```sh
npm install
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

## License

[MIT](LICENSE)
