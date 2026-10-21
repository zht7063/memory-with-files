# Pi package

MWF ships to Pi as an npm tarball, not a plugin zip.

## Build

```sh
npm run pack:release
```

This writes `releases/zht7063-mwf-0.2.0.tgz` (built in pure Node, byte-for-byte reproducible) and lists it in `releases/SHA256SUMS` and `releases/RELEASE-STATUS.json`.

## Verify and install

```sh
cd releases
sha256sum -c SHA256SUMS --ignore-missing
pi install ./zht7063-mwf-0.2.0.tgz
```

Pi finds the extension through the `pi.extensions` field in the package's `package.json` (`./dist/integrations/pi/index.js`).
