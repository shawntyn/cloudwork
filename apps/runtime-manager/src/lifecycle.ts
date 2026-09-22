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
import type { Leases, LeaseKind } from './leases.js';
import { runtimeImageDockerfile } from './runtime-image.js';
import { McpGateway } from './mcp.js';
import { assertRuntimeDataMounts, runtimeBinds, runtimeSpec, runtimeSpecLabel } from './runtime-spec.js';

const managed = 'cloud-work.managed';
const owner = 'cloud-work.user-id';
export const missing = (error: unknown) => !!error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404;

export class RuntimeManager {
  public docker: Docker;
  public mcp: McpGateway;
  public imageId = '';
  private readonly repairAfter = new Map<string, number>();
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
    await this.prepareImage(managerContainer.Image);
    // Compose recreates manager/gateway without their dynamically attached tenant networks.
    // Restore those links before stale-run cancellation tries to reach surviving runtimes.
    const rows = await db.select().from(runtimeInstances);
    for (const row of rows) {
      try {
        await this.leases.withUserLock(row.userId, async () => {
          const info = await this.inspect(row.userId);
          if (!info?.State.Running) return;
          const busy = await this.leases.isBusy(row.userId) || await this.hasRunningSessions(row.userId);
          await this.ensureNetworks(row.userId, !busy);
          await this.repairRuntimeNetworks(row.userId, info, busy);
        });
      } catch (error) { this.log.error(error, 'Runtime network restoration deferred; reconciliation will retry'); }
    }
  }

  async prepareImage(sourceImageId: string) {
    let image: Docker.ImageInspectInfo | undefined;
    try { image = await this.docker.getImage(this.config.image).inspect(); }
    catch (error) {
      if (!missing(error)) throw error;
    }
    if (image?.Config.Labels?.['cloud-work.runtime-source-image'] !== sourceImageId) {
      this.log.info({ image: this.config.image, sourceImage: sourceImageId }, 'Updating user runtime from prepared manager image');
      const context = await mkdtemp(path.join(tmpdir(), 'cloud-work-runtime-image-'));
      try {
        await writeFile(path.join(context, 'Dockerfile'), runtimeImageDockerfile(sourceImageId), { mode: 0o600 });
        const archive = tar.pack(context);
        const stream = await this.docker.buildImage(archive, { t: this.config.image, dockerfile: 'Dockerfile', rm: true, pull: false });
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (error: Error | null) => error ? reject(error) : resolve(), (event: { stream?: string; error?: string }) => {
            if (event.error) this.log.error(event.error, 'Runtime image build error');
            else if (event.stream?.trim()) this.log.info(event.stream.trim());
          });
        });
      } finally { await rm(context, { recursive: true, force: true }); }
      image = await this.docker.getImage(this.config.image).inspect();
    }
    if (image?.Config.Labels?.['cloud-work.runtime-source-image'] !== sourceImageId) throw new Error('Runtime image does not match this deployment');
    this.imageId = image.Id;
  }

  async row(userId: string) {
    return (await db.select().from(runtimeInstances).where(eq(runtimeInstances.userId, safeId(userId))).limit(1))[0];
  }

  async setStatus(userId: string, status: 'STARTING' | 'RUNNING' | 'IDLE' | 'STOPPED' | 'REMOVED' | 'ERROR', containerId?: string | null, touch = true) {
    const now = new Date();
    const values = {
      status, updatedAt: now,
      ...(containerId !== undefined ? { containerId } : {}),
      ...(status === 'STOPPED' ? { stoppedAt: now } : {}),
      ...(status === 'RUNNING' || status === 'STARTING' ? { stoppedAt: null, ...(touch ? { lastActiveAt: now } : {}) } : {}),
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

  private async ensureNetworks(userId: string, reconnect = true) {
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
      if (!reconnect) throw new HttpError(503, 'Runtime network recovery is waiting for active work to finish');
      const network = this.docker.getNetwork(networks.control);
      await network.disconnect({ Container: gateway.Id });
      await network.connect({ Container: gateway.Id, EndpointConfig: { Aliases: [mcpControlAlias(userId)] } });
    }
    return networks;
  }

  private async gatewayContainer() {
    const gateway = await this.docker.getContainer(this.config.mcpGatewayContainer).inspect();
    if (gateway.Name !== `/${this.config.mcpGatewayContainer}` || !gateway.State.Running) throw new Error('Configured MCP gateway container is unavailable');
    return gateway;
  }

  private outdated(userId: string, info: Docker.ContainerInspectInfo) {
    if (!this.imageId) throw new HttpError(503, 'Runtime image is still being prepared');
    return info.Image !== this.imageId || info.Config.Labels?.[runtimeSpecLabel] !== runtimeSpec(this.config, userId);
  }

  private async repairRuntimeNetworks(userId: string, info: Docker.ContainerInspectInfo, busy: boolean) {
    const networks = networkNames(userId);
    for (const name of [networks.egress, networks.control, this.config.network]) {
      const aliases = [runtimeName(userId), ...(name === networks.control ? [runtimeControlAlias(userId)] : [])];
      const current = info.NetworkSettings.Networks[name];
      if (current && aliases.every(alias => current.Aliases?.includes(alias))) continue;
      if (current && busy) throw new HttpError(503, 'Runtime network recovery is waiting for active work to finish');
      const network = this.docker.getNetwork(name);
      if (current) await network.disconnect({ Container: info.Id });
      const endpoint = { Aliases: aliases, GwPriority: name === networks.egress ? 1 : 0 };
      await network.connect({ Container: info.Id, EndpointConfig: endpoint });
    }
  }

  private async health(userId: string) {
    const response = await this.request(userId, '/health', { headers: { connection: 'close' } }, 3000);
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(503, `Runtime health check returned ${response.status}`);
    }
    const value = await response.json() as { ok?: boolean; activeSessions?: number; activeTransfers?: number; uploadBatches?: number };
    if (value.ok !== true) throw new HttpError(503, 'Runtime health check returned an invalid response');
    return { busy: (value.activeSessions ?? 0) > 0 || (value.activeTransfers ?? 0) > 0 || (value.uploadBatches ?? 0) > 0 };
  }

  private async probeHealth(userId: string) {
    // Docker DNS/pooled sockets can briefly refer to the old endpoint after reconnection.
    // A transient failed probe is not sufficient evidence to destroy a healthy container.
    for (let attempt = 0; ; attempt++) {
      try { return await this.health(userId); }
      catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  /** Caller holds the lifecycle lock; no new work can be admitted during replacement. */
  private async replaceContainer(userId: string, info: Docker.ContainerInspectInfo) {
    assertRuntimeDataMounts(this.config, userId, info);
    this.log.info({ userId, containerId: info.Id, imageId: this.imageId }, 'Replacing idle runtime; persistent directories are retained');
    if (info.State.Running) await this.docker.getContainer(info.Id).stop({ t: 10 });
    await this.docker.getContainer(info.Id).remove({ v: false, force: false });
    await this.setStatus(userId, 'REMOVED', null, false);
  }

  private async ensureRuntimeUnlocked(userId: string, touch = true) {
    try {
      let info = await this.inspect(userId);
      let busy = await this.leases.isBusy(userId) || await this.hasRunningSessions(userId);
      const networks = await this.ensureNetworks(userId, !busy);
      if (info) {
        assertRuntimeDataMounts(this.config, userId, info);
        await this.repairRuntimeNetworks(userId, info, busy);
        let healthy = false;
        if (info.State.Running) {
          try { const health = await this.probeHealth(userId); healthy = true; busy ||= health.busy; }
          catch { /* An idle unhealthy container gets one bounded replacement below. */ }
        }
        const outdated = this.outdated(userId, info);
        if (!busy && (outdated || (info.State.Running && !healthy) || (!info.State.Running && this.repairAfter.has(userId)))) {
          if ((this.repairAfter.get(userId) ?? 0) > Date.now()) throw new HttpError(503, 'Runtime recovery is cooling down after a failed attempt. Retry in a few minutes.');
          this.repairAfter.set(userId, Date.now() + 5 * 60_000);
          await this.replaceContainer(userId, info);
          info = undefined;
        } else if (info.State.Running && healthy) {
          this.repairAfter.delete(userId);
          return await this.setStatus(userId, 'RUNNING', info.Id, touch);
        } else if (info.State.Running && busy) {
          throw new HttpError(503, 'Runtime is unavailable while active work is protected. Recovery will retry after it finishes.');
        }
      }
      if (!info) {
        if (!this.imageId) throw new HttpError(503, 'Runtime image is still being prepared');
        this.repairAfter.set(userId, Date.now() + 5 * 60_000);
        await this.setStatus(userId, 'STARTING', undefined, touch);
        await this.prepareDirectories(userId);
        const endpoint = (priority = 0, control = false) => ({ Aliases: [runtimeName(userId), ...(control ? [runtimeControlAlias(userId)] : [])], GwPriority: priority });
        const container = await this.docker.createContainer({
          name: runtimeName(userId), Image: this.imageId, User: '1000:1000', WorkingDir: '/home/work',
          Labels: { [managed]: 'true', [owner]: userId, [runtimeSpecLabel]: runtimeSpec(this.config, userId) },
          Env: runtimeEnvironment(this.config, userId),
          ExposedPorts: { '3080/tcp': {} },
          HostConfig: {
            Binds: runtimeBinds(this.config, userId),
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
        await this.setStatus(userId, 'STARTING', container.id, touch);
        info = await container.inspect();
      }
      if (!info.State.Running) {
        await this.setStatus(userId, 'STARTING', info.Id, touch);
        await this.docker.getContainer(info.Id).start();
      }
      await this.waitHealthy(userId);
      this.repairAfter.delete(userId);
      return await this.setStatus(userId, 'RUNNING', info.Id, touch);
    } catch (error) {
      await this.setStatus(userId, 'ERROR').catch(() => {});
      throw error;
    }
  }

  async ensureRuntime(userId: string) {
    return this.leases.withUserLock(userId, () => this.ensureRuntimeUnlocked(userId));
  }

  /** Background reconciliation never wakes stopped tenants or extends idle timers. */
  async reconcileRuntimeUnlocked(userId: string) {
    const info = await this.inspect(userId);
    if (!info) return;
    if (info.State.Running) { await this.ensureRuntimeUnlocked(userId, false); return; }
    if ((await this.row(userId))?.status === 'ERROR') {
      if ((this.repairAfter.get(userId) ?? 0) > Date.now()) return;
      this.repairAfter.set(userId, 0);
      await this.ensureRuntimeUnlocked(userId, false);
      return;
    }
    if (this.outdated(userId, info) && !await this.leases.isBusy(userId) && !await this.hasRunningSessions(userId)) {
      assertRuntimeDataMounts(this.config, userId, info);
      await this.removeUnlocked(userId);
    }
  }

  async hasRuntimeActivity(userId: string) { return (await this.health(userId)).busy; }

  async admitActivity(userId: string, kind: LeaseKind, id: string, ensure = true) {
    await this.leases.withUserLock(userId, async () => {
      if (ensure) await this.ensureRuntimeUnlocked(userId);
      await this.leases.setBusy(userId, kind, id);
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
        await this.health(userId);
        return;
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new HttpError(503, lastError);
  }

  async withActivity<T>(userId: string, operation: () => Promise<T>, ensureRuntime = true): Promise<T> {
    const id = randomUUID();
    await this.admitActivity(userId, 'active-connections', id, ensureRuntime);
    const heartbeat = setInterval(() => { void this.leases.setBusy(userId, 'active-connections', id).catch(error => this.log.error(error, 'Activity lease refresh failed')); }, this.config.heartbeatMs);
    heartbeat.unref();
    try { return await operation(); }
    finally {
      clearInterval(heartbeat);
      try { await this.touchRuntime(userId); }
      finally { await this.leases.clearBusy(userId, 'active-connections', id); }
    }
  }
}
