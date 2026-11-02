# Releasing

One command publishes a release:

```sh
make release VERSION=0.5.0
```

It publishes:

- the image `ghcr.io/ackstorm/artifact-server:v0.5.0`
- the Helm chart `oci://ghcr.io/ackstorm/charts/artifact-server:0.5.0`, pinned to that image's digest
- the GitHub release `v0.5.0`

## Requirements

- You are on `main`, the working tree is clean, and `main` matches `origin/main`.
- The tag `vVERSION` does not exist yet, and the chart version has not been published.
- `node`, `git`, and an authenticated `gh` (`gh auth status`) are on your `PATH`.
- You can push to `main` and push tags.

## What the command does

`scripts/release.sh` runs these steps in order and stops at the first failure:

1. Checks the requirements above.
2. Sets the version in every place that `scripts/check-release-version.mjs` checks:
   - the root and integration `package.json` files
   - the Helm chart `version` and `appVersion`
   - the image tag in `values.yaml`
   - the MCP server and Claude channel versions
   - the Helm README install command
3. Runs `check-release-version.mjs --tag vVERSION`.
4. Commits `chore(release): set the release version to VERSION` and pushes it to `main`. It skips this step when the version is already set, for example after a release PR merged.
5. Pushes the annotated tag `vVERSION`.
6. Waits up to 90 minutes for the `Ackstorm Release` workflow, then prints the release URL.

Past release runs took 30 to 70 minutes. The command keeps waiting for that whole time, so you can stop it with Ctrl-C at any point. The release continues on GitHub, and `gh run watch <run-id>` picks up where it left off.

## The release workflow

The tag push starts `.github/workflows/ackstorm-release.yml`:

1. It runs the full release gate, `ci.yml` with `tier: release`, without the pnpm cache.
2. It refuses to publish over an existing image tag or chart version.
3. It builds and pushes the multi-architecture image with provenance and an SBOM.
4. It packages the chart with `image.digest` set to the pushed image, checks the digest, and pushes the chart.
5. It creates the GitHub release.

Nothing is published unless the gate passes.

## When a release fails

Read the failure with `gh run view <run-id> --log-failed`.

- **The gate failed before publishing.** Fix the problem on `main`. Then delete the tag and push it again:

  ```sh
  git push origin :refs/tags/vVERSION
  git tag -d vVERSION
  ```

  Run `make release VERSION=X.Y.Z` again. The version is already set, so the command only tags and waits.
- **The image or chart was published.** Do not reuse the version. Release the next patch version instead.

## Deploying a release

Flux pulls the chart from the OCI registry:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: artifact-server
spec:
  interval: 10m
  url: oci://ghcr.io/ackstorm/charts/artifact-server
  ref:
    semver: "0.x"
  layerSelector:
    mediaType: application/vnd.cncf.helm.chart.content.v1.tar+gzip
    operation: copy
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: artifact-server
spec:
  interval: 10m
  chartRef:
    kind: OCIRepository
    name: artifact-server
```

The chart pins the image by digest, so the HelmRelease does not set `image.tag`, `image.digest`, or `allowMutableTag`.

Read the chart's [upgrade notes](../packaging/helm/artifact-server/README.md) before you upgrade. Back up Postgres before an upgrade that runs a migration.
