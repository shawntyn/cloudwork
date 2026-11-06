/**
 * Compose already installed the complete, locked workspace in the manager image.
 * Build a small runtime layer FROM that immutable image rather than repeating
 * apt/pnpm through the Engine legacy builder, whose cache is separate from BuildKit.
 * Compose container environment variables are not part of the source image.
 */
export function runtimeImageDockerfile(sourceImageId: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceImageId)) throw new Error('An immutable manager image ID is required');
  return `FROM ${sourceImageId}
LABEL cloud-work.runtime-image="true" cloud-work.runtime-source-image="${sourceImageId}"
USER 0:0
WORKDIR /app
RUN test -x /opt/workspace-python/bin/python && test -x /usr/local/libexec/cloud-work-no-network \\
    && node /app/node_modules/typescript/bin/tsc --project /app/docker/runtime/tsconfig.json --noEmit \\
    && groupmod -n work node && usermod -l work -d /home/work node \\
    && mkdir -p /home/work/workspaces /home/work/.cache /home/work/.npm /home/work/.config /home/work/.local/share/pnpm \\
    && chown -R work:work /home/work
ENV HOME=/home/work USER=work NODE_ENV=production PNPM_HOME=/home/work/.local/share/pnpm COREPACK_HOME=/opt/corepack COREPACK_DEFAULT_TO_LATEST=0
ENV VIRTUAL_ENV=/opt/workspace-python PYTHONDONTWRITEBYTECODE=1 PIP_NO_INDEX=1
ENV PATH=/opt/workspace-python/bin:/app/packages/runtime-dsh/node_modules/.bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1000:1000
EXPOSE 3080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "/app/node_modules/tsx/dist/loader.mjs", "/app/docker/runtime/src/server.ts"]
`;
}
