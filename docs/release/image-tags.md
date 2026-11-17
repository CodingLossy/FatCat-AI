# Image tags and how a release image is published

Image: `ghcr.io/codinglossy/fatcat-ai` (public package, same as the open-source repository; the address follows the repository, so docs use the `FATCAT_AI_IMAGE` variable). Platforms: `linux/amd64` and `linux/arm64`. Workflow: `.github/workflows/release.yml`. Decision record: ADR 0032.

## Nothing is pushed by default

| Trigger                                                        | Builds                                          | Pushes to GHCR                             |
| -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Pull request that touches `docker/Dockerfile` or the workflow  | yes (each platform, native runner, smoke check) | no                                         |
| Manual run (`workflow_dispatch`) with `push` = false (default) | yes                                             | no                                         |
| Manual run with `push` = true                                  | yes                                             | yes, **only** the tag `sha-<7 characters>` |
| A pushed `v*` tag                                              | yes                                             | yes, the tags below                        |

A manual run never creates `latest` or a version tag. Only a `v*` tag does, and tags are created by the owner after confirming the release.

## Tag policy for `v1.2.3`

| Image tag     | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `1.2.3`       | exactly this release                                                   |
| `1.2`         | latest patch of 1.2                                                    |
| `1`           | latest minor of 1.x (not for `v0.*`)                                   |
| `latest`      | latest stable release (not for pre-release tags such as `v1.0.0-rc.1`) |
| `sha-abc1234` | the commit the image was built from                                    |

Pre-release tags (`v1.0.0-rc.1`) get `1.0.0-rc.1` and `sha-<7>` only. Images carry provenance (`mode=max`) and an SBOM attestation. cosign signing is postponed to 1.0.x (development plan section 16 item 5 concerns the desktop packages).

## Checking that nothing was published

```bash
node scripts/check-no-release.mjs            # tags on origin, GitHub Releases, GHCR tags; exit 0 = none of the three exists
```
