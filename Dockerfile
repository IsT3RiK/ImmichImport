# syntax=docker/dockerfile:1

FROM python:3.12-slim

# --- immich-go: baked into the image (no docker-in-docker needed) ----------
# Pin a release; override at build time with --build-arg IMMICH_GO_VERSION=vX.Y.Z
ARG IMMICH_GO_VERSION=v0.32.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) GOARCH=x86_64 ;; \
      arm64) GOARCH=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/simulot/immich-go/releases/download/${IMMICH_GO_VERSION}/immich-go_Linux_${GOARCH}.tar.gz"; \
    echo "Downloading $url"; \
    curl -fsSL "$url" -o /tmp/immich-go.tar.gz; \
    tar -xzf /tmp/immich-go.tar.gz -C /usr/local/bin immich-go; \
    chmod +x /usr/local/bin/immich-go; \
    rm /tmp/immich-go.tar.gz; \
    /usr/local/bin/immich-go version || true

# --- python app ------------------------------------------------------------
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV IMPORT_ROOT=/import \
    PORT=8080 \
    ALBUM_MODE=FOLDER

EXPOSE 8080

# immich-go stores a small run cache/config under $HOME; keep it writable.
ENV HOME=/srv

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
