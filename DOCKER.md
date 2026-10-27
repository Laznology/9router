# Docker

Run 9Router in a container. Published image: `ghcr.io/laznology/9router` — `linux/amd64`.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  ghcr.io/laznology/9router:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f 9router        # view logs
docker stop 9router           # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 9router \
  ghcr.io/laznology/9router:latest
```

## Optional Headroom sidecar

The 9Router image does not bundle Python or Headroom. To use Headroom in Docker, run the official image as a separate service and point 9Router at that proxy:

```yaml
services:
  9router:
    image: ghcr.io/laznology/9router:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/headroomlabs-ai/headroom:latest
    restart: always
    # The image binds 127.0.0.1 inside the container by default.
    command: ["--host", "0.0.0.0"]
    environment:
      # Acknowledge the 0.0.0.0 bind. Safe here because the host port is
      # loopback-only and the compose network is private.
      HEADROOM_ALLOW_UNAUTHENTICATED_BIND: "1"
      # /v1/compress is loopback-only by default and returns 404 to peer
      # containers. This is Headroom's opt-in for a trusted in-network sidecar.
      HEADROOM_COMPRESS_ALLOW_REMOTE: "1"
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - headroom_data:/home/nonroot/.headroom

volumes:
  headroom_data:
```

Do not publish `8787` on `0.0.0.0` without `HEADROOM_PROXY_TOKEN`: 9Router does not send a proxy auth header, so the token would break compression, and an open port relays requests with your upstream credentials.

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry. The host process must also bind a reachable interface (`headroom proxy --host 0.0.0.0`) and set `HEADROOM_COMPRESS_ALLOW_REMOTE=1`; keep it behind a firewall.

## Update to latest

```bash
docker pull ghcr.io/laznology/9router:latest
docker rm -f 9router
# re-run the quick start command
```

To pin a specific version instead of following `latest`, use a numbered image tag:

```bash
docker pull ghcr.io/laznology/9router:0.5.81
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router
```

The Dockerfile uses the official Alpine and npm registries by default. Regional mirrors can be supplied when needed:

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ \
  -t 9router .
```

## Publish (automatic via CI)

Push a Docker-safe semver git tag `vX.Y.Z` (or a prerelease such as `vX.Y.Z-rc.1`) → GitHub Actions builds and health-checks one `linux/amd64` image, verifies its manifest and `/api/health`, then publishes:

- `ghcr.io/<owner>/<repo>:X.Y.Z` + `:latest`

The `v` prefix is used only for the git tag; image tags omit it. A stable tag push promotes `latest`, but a prerelease tag such as `vX.Y.Z-rc.1` publishes only its numbered image by default. Prereleases require an explicit manual `promote_latest` opt-in. Promotion happens only after the amd64 build and health checks, manifest inspection, and the resolved-manifest smoke test succeed. A failed or timed-out build therefore cannot move `latest`.

The workflow rejects SemVer build metadata such as `v1.2.3+build.7` because the `+` form is not a valid Docker image tag. The git tag and both `package.json` versions must match exactly.

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.5.81 && git push origin v0.5.81
```

To republish an existing tag, run the `Build and Push Docker Image` workflow manually and provide the exact tag, for example `v0.5.81`, in the `release_tag` input. Manual runs publish the numbered tag but leave `latest` unchanged by default:

```text
release_tag:     v0.5.81
promote_latest:  false
```

The `promote_latest` checkbox is an explicit opt-in for changing `latest`. Use it when a deliberate rollback or recovery should make that version the current default:

```text
release_tag:     v0.5.75
promote_latest:  true
```

Numbered image tags are mutable because a republish can replace their manifest. For a deployment that must be immutable, pin the image digest instead:

```bash
docker pull ghcr.io/laznology/9router@sha256:<verified-digest>
```

The release workflow builds and runs `/api/health` on `linux/amd64` before uploading the digest artifact and assembling the image manifest. It then runs a second health check against the resolved version manifest before any requested `latest` promotion.

During recovery, the selected tag remains the application source while the Dockerfile from the workflow revision is used, so an older tag can be rebuilt with the current publishing fixes.

The workflow is tag-driven. Creating a git tag does not automatically create a GitHub Release, so the Releases page and the published package/image tags can be at different versions unless a maintainer creates a release separately.

GHCR publishing uses the workflow's `GITHUB_TOKEN` with package write permission; no PAT or registry-specific secrets are needed. The image path follows the repository owner/name.

The optional repository variables `ALPINE_MIRROR` and `NPM_REGISTRY` can override the default package mirrors used by the CI Docker build.

Workflow: `.github/workflows/docker-publish.yml`
