# Purpose

Docker production deployment helpers.

## Ownership

Project Maintainers and DevOps Agents.

## Local Contracts

- Scripts must remain idempotent, use `set -euo pipefail`, and never embed hardcoded secrets or external project names.
- Multi-stage `Dockerfile` `builder` must run on `$BUILDPLATFORM`, install `git` and `npm@latest` (`>= 12.2.2`), copy `.npmrc` (`allow-git=all`), copy `public/` so `favicon.svg` ships inside `/app/dist`, and rewrite `ssh://git@github.com/` to `https://github.com/` so `npm ci` can resolve public Git devDependencies like `@francogp/auditor` in CI without SSH keys.
- Multi-stage `Dockerfile` bundles static `ffmpeg` + `ffprobe` from `mwader/static-ffmpeg:latest` directly into `/usr/local/bin` inside the final `runtime` stage (`USER 1000:1000`, `HOME=/tmp`, `read_only: true` compatible, copying `package.json`, `dist/`, `src/domain/`, `src/server/`, and the required backend runtime packages from `node_modules`).
- **Docker Runtime Dependency Synchronization**: Whenever adding, updating, or modifying npm dependencies imported by `src/server/**` or `src/domain/**`, update the `COPY --from=builder /app/node_modules/<pkg>` directives in the `Dockerfile` `runtime` stage to include every direct and transitive package (verified automatically by `tests/server/dockerfileRuntimeDeps.test.ts`).
- `docker-compose.yml` requires explicit `.env` mount paths (`CONFIG_DIR`, `INPUT_DIR`, `BACKUP_DIR`, and `OUTPUT_*_DIR` via `:?` fail-fast interpolation) so containers never silently bind unconfigured host paths under root ownership.

## Work Guidance

- Keep shared Docker and environment bootstrap logic in `deploy-common.sh` for use by root `deploy-install.sh` and `deploy-update.sh`.

## Verification

- Validate shell scripts and DOX integrity with `npm run auditor:lint`.

## Child DOX Index

- [deploy-common.sh](deploy-common.sh): Shared Docker, `.env`, and Compose lifecycle helpers.
