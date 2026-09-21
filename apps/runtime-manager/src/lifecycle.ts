import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import tar from 'tar-fs';
import { and, eq } from 'drizzle-orm';
import { db, runtimeInstances, agentSessions } from '@cloud-work/database';
import type { Config } from './config.js';
import { HttpError, mcpControlAlias, networkNames, runtimeControlAlias, runtimeEnvironment, runtimeName, runtimeToken, safeId } from './config.js';
import type { Leases } from './leases.js';
import { runtimeImageDockerfile } from './runtime-image.js';
import { McpGateway } from './mcp.js';

const managed = 'cloud-work.managed';
const owner = 'cloud-work.user-id';
export const missing = (error: unknown) => !!error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404;

export class RuntimeManager {
  public docker: Docker;
  public mcp: McpGateway;
  constructor(public config: Config, public leases: Leases, private log: { info: (value: unknown, message?: string) => void; error: (value: unknown, message?: string) => void }) {
    this.docker = new Docker({ socketPath: config.dockerSocket });
    this.mcp = new McpGateway(config);
  }

  async initialize() {
    if (!this.config.mcpGatewayAdminToken) throw new Error('MCP_GATEWAY_ADMIN_TOKEN is required');
    await this.docker.ping();
    const shared = await this.docker.getNetwork(this.config.network).inspect();
    if (!shared.Internal || shared.Options?.['com.docker.network.bridge.enable_icc'] !== 'false') throw new Error('RUNTIME_NETWORK must be internal and have inter-container communication disabled');
    const managerContainer = await this.docker.getContainer(this.config.managerContainer).inspect();
    await this.gatewayContainer();
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o711 });
    try { await this.docker.getImage(this.config.image).inspect(); }
    catch (error) {
      if (!missing(error)) throw error;
      this.log.info({ image: this.config.image, sourceImage: managerContainer.Image }, 'Building user runtime from prepared manager image');
      const context = await mkdtemp(path.join(tmpdir(), 'cloud-work-runtime-image-'));
      try {
        await writeFile(path.join(context, 'Dockerfile'), runtimeImageDockerfile(managerContainer.Image), { mode: 0o600 });
        const archive = tar.pack(context);
        const stream = await this.docker.buildImage(archive, { t: this.config.image, dockerfile: 'Dockerfile', rm: true, pull: false });
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (error: Error | null) => error ? reject(error) : resolve(), (event: { stream?: string; error?: string }) => {
            if (event.error) this.log.error(event.error, 'Runtime image build error');
            else if (event.stream?.trim()) this.log.info(event.stream.trim());
          });
        });
      } finally { await rm(context, { recursive: true, force: true }); }
      await this.docker.getImage(this.config.image).inspect();
    }
  }

  async row(userId: string) {
    return (await db.select().from(runtimeInstances).where(eq(runtimeInstances.userId, safeId(userId))).limit(1))[0];
  }

  async setStatus(userId: string, status: 'STARTING' | 'RUNNING' | 'IDLE' | 'STOPPED' | 'REMOVED' | 'ERROR', containerId?: string | null) {
    const now = new Date();
    const values = {
      status, updatedAt: now,
      ...(containerId !== undefined ? { containerId } : {}),
      ...(status === 'STOPPED' ? { stoppedAt: now } : {}),
      ...(status === 'RUNNING' || status === 'STARTING' ? { stoppedAt: null, lastActiveAt: now } : {}),
    };
    await db.insert(runtimeInstances).values({
      id: `rt_${randomUUID()}`, userId: safeId(userId), containerName: runtimeName(userId), hostId: this.config.hostId,
      lastActiveAt: now, createdAt: now, ...values,
    }).onConflictDoUpdate({ target: runtimeInstances.userId, set: values });
    return (await this.row(userId))!;
  }

  async touchRuntime(userId: string) {
    await db.update(runtimeInstances).set({ lastActiveAt: new Date(), updatedAt: new Date() }).where(eq(runtimeInstances.userId, safeId(userId)));
  }

  async inspect(userId: string): Promise<Docker.ContainerInspectInfo | undefined> {
    try {
      const info = await this.docker.getContainer(runtimeName(userId)).inspect();
      if (info.Config.Labels?.[managed] !== 'true' || info.Config.Labels?.[owner] !== userId) throw new HttpError(409, 'Runtime container name belongs to another owner');
      return info;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }

  private async prepareDirectories(userId: string) {
    const userRoot = path.join(this.config.dataRoot, safeId(userId));
    const directories = [userRoot, path.join(userRoot, 'home'), path.join(userRoot, 'workspaces')];
    for (const directory of directories) {
      await mkdir(directory, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(409, 'User data directory must be a real directory');
      await chown(directory, 1000, 1000);
      await chmod(directory, 0o700);
    }
    return { home: directories[1]!, workspaces: directories[2]! };
  }

  private async ensureNetwork(name: string, userId: string, internal: boolean) {
    try {
      const info = await this.docker.getNetwork(name).inspect();
      if (info.Labels?.[owner] !== userId || info.Labels?.[managed] !== 'true' || info.Internal !== internal) throw new Error('Runtime network ownership or isolation mismatch');
    } catch (error) {
      if (!missing(error)) throw error;
      await this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: internal, CheckDuplicate: true, Labels: { [managed]: 'true', [owner]: userId }, Options: { 'com.docker.network.bridge.enable_icc': 'true' } });
    }
  }

  private async ensureNetworks(userId: string) {
    const networks = networkNames(userId);
    await this.ensureNetwork(networks.control, userId, true);
    await this.ensureNetwork(networks.egress, userId, false);
    const manager = await this.docker.getContainer(this.config.managerContainer).inspect();
    if (!manager.NetworkSettings.Networks[networks.control]) {
      await this.docker.getNetwork(networks.control).connect({ Container: this.config.managerContainer });
    }
    const gateway = await this.gatewayContainer();
    const gatewayEndpoint = gateway.NetworkSettings.Networks[networks.control];
    if (!gatewayEndpoint) {
      await this.docker.getNetwork(networks.control).connect({ Container: gateway.Id, EndpointConfig: { Aliases: [mcpControlAlias(userId)] } });
    } else if (!gatewayEndpoint.Aliases?.includes(mcpControlAlias(userId))) {
      throw new Error('MCP gateway control network alias mismatch');
    }
    return networks;
  }

  private async gatewayContainer() {
    const gateway = await this.docker.getContainer(this.config.mcpGatewayContainer).inspect();
    if (gateway.Name !== `/${this.config.mcpGatewayContainer}` || !gateway.State.Running) throw new Error('Configured MCP gateway container is unavailable');
    return gateway;
  }

  async ensureRuntime(userId: string) {
    return this.leases.withUserLock(userId, async () => {
      try {
        let info = await this.inspect(userId);
        const networks = await this.ensureNetworks(userId);
        if (!info) {
          await this.setStatus(userId, 'STARTING');
          const directories = await this.prepareDirectories(userId);
          const endpoint = (priority = 0, control = false) => ({ Aliases: [runtimeName(userId), ...(control ? [runtimeControlAlias(userId)] : [])], GwPriority: priority });
          const container = await this.docker.createContainer({
            name: runtimeName(userId), Image: this.config.image, User: '1000:1000', WorkingDir: '/home/work',
            Labels: { [managed]: 'true', [owner]: userId },
            Env: runtimeEnvironment(this.config, userId),
            ExposedPorts: { '3080/tcp': {} },
            HostConfig: {
              Binds: [`${directories.home}:/home/work:rw`, `${directories.workspaces}:/home/work/workspaces:rw`],
              NanoCpus: Math.round(this.config.cpus * 1e9), Memory: Math.round(this.config.memoryMb * 1024 * 1024),
              MemorySwap: Math.round(this.config.memoryMb * 1024 * 1024), PidsLimit: this.config.pids,
              CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false,
              Init: true, NetworkMode: networks.egress, RestartPolicy: { Name: 'no' },
              LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
            },
            NetworkingConfig: { EndpointsConfig: {
              [networks.egress]: endpoint(1), [networks.control]: endpoint(0, true), [this.config.network]: endpoint(),
            } },
          });
          await this.setStatus(userId, 'STARTING', container.id);
          info = await container.inspect();
        }
        if (!info.State.Running) {
          await this.setStatus(userId, 'STARTING', info.Id);
          await this.docker.getContainer(info.Id).start();
        }
        await this.waitHealthy(userId);
        return await this.setStatus(userId, 'RUNNING', info.Id);
      } catch (error) {
        await this.setStatus(userId, 'ERROR').catch(() => {});
        throw error;
      }
    });
  }

  async startRuntime(userId: string) { return this.ensureRuntime(userId); }

  async getRuntimeStatus(userId: string) {
    return this.leases.withUserLock(userId, async () => {
      const row = await this.row(userId), info = await this.inspect(userId);
      if (!info) return row ? this.setStatus(userId, 'REMOVED', null) : { status: 'REMOVED' as const };
      if (!info.State.Running) {
        if (row?.status === 'STOPPED' || row?.status === 'ERROR') return row;
        return this.setStatus(userId, info.State.ExitCode ? 'ERROR' : 'STOPPED', info.Id);
      }
      if (row?.status === 'ERROR') return row;
      const status = await this.leases.isBusy(userId) ? 'RUNNING' : 'IDLE';
      if (row && (row.status === 'RUNNING' || row.status === 'IDLE')) {
        await db.update(runtimeInstances).set({ status, updatedAt: new Date() }).where(eq(runtimeInstances.userId, userId));
        return { ...row, status };
      }
      return this.setStatus(userId, status, info.Id);
    });
  }

  async hasRunningSessions(userId: string) {
    return (await db.select({ id: agentSessions.id }).from(agentSessions).where(and(eq(agentSessions.userId, userId), eq(agentSessions.status, 'running'))).limit(1)).length > 0;
  }

  async stopUnlocked(userId: string, force = false) {
    if (!force && (await this.leases.isBusy(userId) || await this.hasRunningSessions(userId))) throw new HttpError(409, 'Runtime has active work; stop the agent first');
    const info = await this.inspect(userId);
    if (info?.State.Running) await this.docker.getContainer(info.Id).stop({ t: 10 });
    return this.setStatus(userId, info ? 'STOPPED' : 'REMOVED', info?.Id ?? null);
  }

  async removeUnlocked(userId: string) {
    if (await this.leases.isBusy(userId) || await this.hasRunningSessions(userId)) throw new HttpError(409, 'Runtime has active work; stop the agent first');
    const info = await this.inspect(userId);
    if (info?.State.Running) await this.docker.getContainer(info.Id).stop({ t: 10 });
    if (info) await this.docker.getContainer(info.Id).remove({ v: false, force: false });
    // Only managed container and networks are removed. Bind-mounted user directories are never deleted.
    for (const name of Object.values(networkNames(userId))) {
      const network = this.docker.getNetwork(name);
      try {
        const details = await network.inspect();
        if (details.Labels?.[owner] !== userId || details.Labels?.[managed] !== 'true') throw new Error('Refusing to remove unowned network');
        for (const id of Object.keys(details.Containers ?? {})) {
          const container = await this.docker.getContainer(id).inspect();
          if (container.Name === `/${this.config.managerContainer}` || container.Name === `/${this.config.mcpGatewayContainer}`) await network.disconnect({ Container: id, Force: true });
        }
        await network.remove();
      } catch (error) { if (!missing(error)) throw error; }
    }
    return this.setStatus(userId, 'REMOVED', null);
  }

  async stopRuntime(userId: string) { return this.leases.withUserLock(userId, () => this.stopUnlocked(userId)); }
  async removeRuntime(userId: string) { return this.leases.withUserLock(userId, () => this.removeUnlocked(userId)); }

  async address(userId: string) {
    const info = await this.inspect(userId);
    if (!info?.State.Running) throw new HttpError(503, 'Runtime is not running');
    const network = info.NetworkSettings.Networks[networkNames(userId).control];
    const alias = runtimeControlAlias(userId);
    if (!network?.IPAddress || !network.Aliases?.includes(alias)) throw new HttpError(503, 'Runtime control network unavailable');
    return `http://${alias}:3080`;
  }

  async request(userId: string, suffix: string, init: RequestInit = {}, timeoutMs = 30_000) {
    if (!suffix.startsWith('/') || suffix.startsWith('//')) throw new Error('Invalid runtime route');
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    headers.set('authorization', `Bearer ${runtimeToken(userId, this.config.tokenSecret)}`);
    return fetch(`${await this.address(userId)}${suffix}`, {
      ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers,
    });
  }

  private async waitHealthy(userId: string) {
    const deadline = Date.now() + 90_000;
    let lastError = 'Runtime did not become ready';
    while (Date.now() < deadline) {
      const info = await this.inspect(userId);
      if (!info?.State.Running) throw new HttpError(503, `Runtime exited during startup (exit ${info?.State.ExitCode ?? 'unknown'}); inspect runtime logs for sandbox readiness`);
      try {
        const response = await this.request(userId, '/health', {}, 3000);
        if (response.ok) return;
        lastError = `Runtime health check returned ${response.status}`;
        await response.body?.cancel();
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new HttpError(503, lastError);
  }

  async withActivity<T>(userId: string, operation: () => Promise<T>, ensureRuntime = true): Promise<T> {
    const id = randomUUID();
    await this.leases.setBusy(userId, 'active-connections', id);
    const heartbeat = setInterval(() => { void this.leases.setBusy(userId, 'active-connections', id).catch(error => this.log.error(error, 'Activity lease refresh failed')); }, this.config.heartbeatMs);
    heartbeat.unref();
    try { if (ensureRuntime) await this.ensureRuntime(userId); return await operation(); }
    finally {
      clearInterval(heartbeat);
      try { await this.touchRuntime(userId); }
      finally { await this.leases.clearBusy(userId, 'active-connections', id); }
    }
  }
}
