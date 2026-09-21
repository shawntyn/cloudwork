FROM node:24.20.0-bookworm-slim AS tools
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash bubblewrap ca-certificates curl git openssh-client python3 python3-pip \
    python3-venv build-essential pkg-config ripgrep jq unzip zip socat tini \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY docker/runtime/requirements.txt /opt/cloud-work/requirements.txt
RUN python3 -m venv /opt/workspace-python \
    && /opt/workspace-python/bin/python -m pip install --disable-pip-version-check --no-cache-dir --require-hashes --only-binary=:all: --retries 5 --timeout 120 -r /opt/cloud-work/requirements.txt \
    && /opt/workspace-python/bin/python -m pip check \
    && /opt/workspace-python/bin/python -c "import io, numpy, pandas, docx, yaml; assert pandas.DataFrame({'value': numpy.array([1, 2, 3])})['value'].sum() == 6; assert yaml.safe_load('offline: true')['offline']; document = docx.Document(); document.add_paragraph('offline'); output = io.BytesIO(); document.save(output); assert output.getbuffer().nbytes > 0" \
    && chown -R root:root /opt/workspace-python /opt/cloud-work \
    && chmod -R a+rX,go-w /opt/workspace-python /opt/cloud-work
ENV VIRTUAL_ENV=/opt/workspace-python PYTHONDONTWRITEBYTECODE=1 PIP_NO_INDEX=1
ENV PATH=/opt/workspace-python/bin:/app/packages/runtime-dsh/node_modules/.bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
FROM tools AS runtime
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/runtime-manager/package.json apps/runtime-manager/package.json
COPY apps/mcp-gateway/package.json apps/mcp-gateway/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY packages/runtime-dsh/package.json packages/runtime-dsh/package.json
COPY packages/workspace/package.json packages/workspace/package.json
COPY docker/runtime/package.json docker/runtime/package.json
COPY packages/runtime-dsh/patches packages/runtime-dsh/patches
RUN pnpm install --frozen-lockfile --fetch-timeout 600000 --fetch-retries 5
# Share the prepared package manager across user HOME bind mounts; no bootstrap download.
RUN cp -a /root/.cache/node/corepack /opt/corepack && chmod -R a+rX /opt/corepack
ENV COREPACK_HOME=/opt/corepack COREPACK_DEFAULT_TO_LATEST=0
COPY . .
RUN mkdir -p /usr/local/libexec \
    && cc -static -std=c11 -O2 -Wall -Wextra -Werror docker/runtime/no-network.c -o /usr/local/libexec/cloud-work-no-network \
    && chmod 0755 /usr/local/libexec/cloud-work-no-network \
    && pnpm --filter @cloud-work/runtime-server typecheck \
    && groupmod -n work node && usermod -l work -d /home/work node \
    && mkdir -p /home/work/workspaces /home/work/.cache /home/work/.npm /home/work/.config \
    && chown -R work:work /home/work
ENV HOME=/home/work
ENV PNPM_HOME=/home/work/.local/share/pnpm
ENV PATH=/opt/workspace-python/bin:/app/packages/runtime-dsh/node_modules/.bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV USER=work
ENV NODE_ENV=production
USER 1000:1000
EXPOSE 3080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "/app/node_modules/tsx/dist/loader.mjs", "/app/docker/runtime/src/server.ts"]
