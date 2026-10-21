# Pi package

MWF ships to Pi as an npm tarball built by `npm run pack:release`.

## Build

```sh
npm ci
npm run build
npm run pack:release
```

This writes `releases/zht7063-mwf-0.2.0.tgz` (deterministic: fixed tar metadata, gzip OS byte 255) and lists it in `releases/SHA256SUMS` and `releases/RELEASE-STATUS.json`.

## Verify and install

Pi 1.3.0 loads extensions from a directory, not from a `.tgz` path. Extract first, then install the package folder:

```sh
cd releases
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /tmp/mwf-pi && tar -xzf zht7063-mwf-0.2.0.tgz -C /tmp/mwf-pi
pi install /tmp/mwf-pi/package
```

Pi finds the extension through `pi.extensions` in `package/package.json` (`./dist/integrations/pi/index.js`).

## Uninstall

```sh
node /tmp/mwf-pi/package/dist/cli.js detach --root /abs/project --harness pi --apply
pi remove /tmp/mwf-pi/package          # add --local if installed with --local
rm -rf /tmp/mwf-pi
```

`pi install` only adds a `packages` entry to `~/.pi/agent/settings.json` (or `.pi/settings.json` with `--local`); it does not copy the package. `.mwf/` data is kept. Full inventory: [../UNINSTALL.md](../UNINSTALL.md).
