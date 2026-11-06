FROM node:24.20.0-bookworm-slim AS tools
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    bash bubblewrap ca-certificates curl git openssh-client python3 python3-pip \
    python3-venv build-essential pkg-config ripgrep jq unzip zip socat tini \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY docker/runtime/requirements.txt /opt/cloud-work/requirements.txt
RUN python3 -m venv /opt/workspace-python \
    && /opt/workspace-python/bin/python -m pip install --disable-pip-version-check --no-cache-dir --require-hashes --only-binary=:all: --retries 5 --timeout 120 -r /opt/cloud-work/requirements.txt \
    && /opt/workspace-python/bin/python -m pip check \
    && /opt/workspace-python/bin/python -c "import io, numpy, pandas, docx, yaml; assert pandas.DataFrame({'value': numpy.array([1, 2, 3])})['value'].sum() == 6; assert yaml.safe_load('offline: true')['offline']; document = docx.Document(); document.add_paragraph('offline'); output = io.BytesIO(); document.save(output); assert output.getbuffer().nbytes > 0" \
    && /opt/workspace-python/bin/python -c "import io, openpyxl, pandas, xlsxwriter; data = pandas.DataFrame({'value': [1, 2, 3]}); outputs = [io.BytesIO(), io.BytesIO()]; [data.to_excel(output, index=False, engine=engine) for output, engine in zip(outputs, ['openpyxl', 'xlsxwriter'])]; [output.seek(0) for output in outputs]; assert all(list(openpyxl.load_workbook(output).active.values) == [('value',), (1,), (2,), (3,)] for output in outputs)" \
    && chown -R root:root /opt/workspace-python /opt/cloud-work \
    && chmod -R a+rX,go-w /opt/workspace-python /opt/cloud-work
ENV VIRTUAL_ENV=/opt/workspace-python PYTHONDONTWRITEBYTECODE=1 PIP_NO_INDEX=1
ENV PATH=/opt/workspace-python/bin:/app/packages/runtime-dsh/node_modules/.bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
FROM tools AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/runtime-manager/package.json apps/runtime-manager/package.json
COPY apps/mcp-gateway/package.json apps/mcp-gateway/package.json
COPY apps/computer-runner/package.json apps/computer-runner/package.json
COPY apps/desktop-control/package.json apps/desktop-control/package.json
COPY apps/desktop-gateway/package.json apps/desktop-gateway/package.json
COPY packages/computer/package.json packages/computer/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY packages/runtime-dsh/package.json packages/runtime-dsh/package.json
COPY packages/workspace/package.json packages/workspace/package.json
COPY docker/runtime/package.json docker/runtime/package.json
COPY packages/runtime-dsh/patches packages/runtime-dsh/patches
RUN --mount=type=cache,target=/app/.pnpm-store,id=cloud-work-pnpm-store pnpm install --frozen-lockfile --fetch-timeout 600000 --fetch-retries 5
# Share the prepared package manager across user HOME bind mounts; no bootstrap download.
RUN cp -a /root/.cache/node/corepack /opt/corepack && chmod -R a+rX /opt/corepack
ENV COREPACK_HOME=/opt/corepack COREPACK_DEFAULT_TO_LATEST=0
COPY docker/runtime/no-network.c docker/runtime/no-network.c
RUN mkdir -p /usr/local/libexec \
    && cc -static -std=c11 -O2 -Wall -Wextra -Werror docker/runtime/no-network.c -o /usr/local/libexec/cloud-work-no-network \
    && chmod 0755 /usr/local/libexec/cloud-work-no-network

FROM dependencies AS source
COPY . .

FROM source AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @cloud-work/web build

FROM source AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=web-build --chown=node:node /app/apps/web/.next /app/apps/web/.next
USER node
EXPOSE 3000
CMD ["sh", "-c", "node --import tsx packages/database/src/migrate.ts && node apps/web/node_modules/next/dist/bin/next start apps/web --hostname 0.0.0.0"]

FROM source AS runtime-manager
ENV NODE_ENV=production
EXPOSE 4000
CMD ["sh", "-c", "node --import tsx packages/database/src/migrate.ts && node --import tsx apps/runtime-manager/src/index.ts"]

FROM source AS mcp-gateway
ENV NODE_ENV=production
USER node
EXPOSE 4100
CMD ["sh", "-c", "node --import tsx packages/database/src/migrate.ts && node --import tsx apps/mcp-gateway/src/index.ts"]


FROM source AS computer-runner
ENV NODE_ENV=production
USER node
EXPOSE 4200
CMD ["node", "--import", "tsx", "apps/computer-runner/src/index.ts"]

FROM dependencies AS desktop-gateway
RUN --mount=type=cache,target=/var/cache/apt,id=cloud-work-desktop-gateway-apt,sharing=locked rm -f /etc/apt/apt.conf.d/docker-clean && (apt-get -o Acquire::Retries=5 update || apt-get -o Acquire::Retries=5 update || apt-get -o Acquire::Retries=5 update) && (apt-get -o Acquire::Retries=5 install -y --no-install-recommends novnc || apt-get -o Acquire::Retries=5 install -y --no-install-recommends novnc || apt-get -o Acquire::Retries=5 install -y --no-install-recommends novnc) && rm -rf /var/lib/apt/lists/*
COPY . .
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/desktop-gateway/src/index.ts"]

FROM dependencies AS desktop-control
RUN --mount=type=cache,target=/var/cache/apt,id=cloud-work-desktop-control-apt,sharing=locked rm -f /etc/apt/apt.conf.d/docker-clean && (apt-get -o Acquire::Retries=5 update || apt-get -o Acquire::Retries=5 update || apt-get -o Acquire::Retries=5 update) && (apt-get -o Acquire::Retries=5 install -y --no-install-recommends x11vnc xdotool imagemagick x11-utils xclip || apt-get -o Acquire::Retries=5 install -y --no-install-recommends x11vnc xdotool imagemagick x11-utils xclip || apt-get -o Acquire::Retries=5 install -y --no-install-recommends x11vnc xdotool imagemagick x11-utils xclip) && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
COPY . .
ENV NODE_ENV=production DISPLAY=:99 HOME=/tmp
USER 1001:1001
EXPOSE 8080 5900 5901
CMD ["node", "--import", "tsx", "apps/desktop-control/src/index.ts"]

FROM node:24.20.0-bookworm-slim AS desktop
RUN --mount=type=cache,target=/var/cache/apt,id=cloud-work-desktop-gui-apt,sharing=locked rm -f /etc/apt/apt.conf.d/docker-clean && (apt-get -o Acquire::Retries=5 update || apt-get -o Acquire::Retries=5 update || apt-get -o Acquire::Retries=5 update) && (apt-get -o Acquire::Retries=5 install -y --no-install-recommends chromium xfce4 xfce4-terminal mousepad dbus-x11 xvfb x11-utils x11-xserver-utils xdg-user-dirs xdg-utils fonts-noto-cjk fonts-liberation adwaita-icon-theme ca-certificates tini || apt-get -o Acquire::Retries=5 install -y --no-install-recommends chromium xfce4 xfce4-terminal mousepad dbus-x11 xvfb x11-utils x11-xserver-utils xdg-user-dirs xdg-utils fonts-noto-cjk fonts-liberation adwaita-icon-theme ca-certificates tini || apt-get -o Acquire::Retries=5 install -y --no-install-recommends chromium xfce4 xfce4-terminal mousepad dbus-x11 xvfb x11-utils x11-xserver-utils xdg-user-dirs xdg-utils fonts-noto-cjk fonts-liberation adwaita-icon-theme ca-certificates tini) \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/.X11-unix /workspace /home/node/.config /etc/chromium/policies/managed \
    && chmod 1777 /tmp/.X11-unix && chown -R node:node /workspace /home/node
COPY docker/desktop/ /opt/desktop/
COPY docker/desktop/chromium.json /etc/chromium/policies/managed/cloud-work.json
RUN chmod 755 /opt/desktop/*.sh
ENV DISPLAY=:99 HOME=/home/node LANG=C.UTF-8 XDG_CURRENT_DESKTOP=XFCE XDG_SESSION_TYPE=x11
USER node
WORKDIR /workspace
CMD ["/opt/desktop/start.sh"]

FROM node:24.20.0-bookworm-slim AS desktop-egress
COPY docker/desktop/egress.mjs /opt/egress.mjs
USER 1001:1001
EXPOSE 3128
CMD ["node", "/opt/egress.mjs"]
