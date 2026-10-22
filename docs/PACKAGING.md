# Local macOS app

The packaging script builds a standalone `TaskSprig.app` for the current Mac's architecture. It uses the exact Electron version installed from the lockfile and gives TaskSprig its own bundle identifier, `org.tasksprig.desktop`, so it can be selected separately from other Electron apps.

From the repository root:

```sh
npm ci
node scripts/package-mac.mjs
```

The packaging dependency is `@electron/packager`, installed as a development dependency. If it has not yet been added to your checkout:

```sh
npm install --save-dev @electron/packager
```

The script runs the production build, packages production dependencies, and verifies the bundle identifier and required runtime files. It may download the matching Electron runtime if it is not already cached. Re-running it replaces the previous package for the same architecture.

On Apple Silicon, launch the result with:

```sh
open artifacts/TaskSprig-darwin-arm64/TaskSprig.app
```

On an Intel Mac, replace `arm64` with `x64`.

To keep a packaged demo's data separate from your normal workspace, run its executable with an explicit data directory:

```sh
TASKSPRIG_DATA_DIR="$PWD/.local-data/packaged-demo" \
  ./artifacts/TaskSprig-darwin-arm64/TaskSprig.app/Contents/MacOS/TaskSprig
```

The package contains only the production `dist` files, production `node_modules`, `package.json`, and `LICENSE`. Local databases, saved model settings, environment files, source files, screenshots, tests, and previous artifacts are excluded. Application data is created at runtime outside the bundle; credentials are never copied into the package. The output directory, `artifacts/`, is ignored by Git.

This produces an unsigned local demo. It does not install, sign, notarize, upload, or publish the app. Distribution signing and notarization are separate future work. See the official [Electron Packager options](https://electron.github.io/packager/main/interfaces/Options.html) for packaging configuration.
