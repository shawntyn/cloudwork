import { createHash, createHmac } from 'node:crypto';
import { mkdir, realpath, lstat, chmod, chown, cp, statfs, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import type Docker from 'dockerode';
import type { RuntimeManager } from './lifecycle.js';
import { missing } from './lifecycle.js';
import { createPooledNetwork } from './network-pool.js';
import { HttpError, safeId } from './config.js';

export function desktopNames(workspaceId: string) {
  const prefix = 'cloud-desktop-' + createHash('sha256').update(safeId(workspaceId)).digest('hex').slice(0, 24);
  return { prefix, gui: prefix + '-gui', control: prefix + '-control', egress: prefix + '-egress', private: prefix + '-private', network: prefix + '-network', output: prefix + '-output', socket: prefix + '-x11' };
}
export class DesktopContainers {
  constructor(private manager: RuntimeManager) {}
  token(workspaceId: string) { return createHmac('sha256', this.manager.config.tokenSecret).update('desktop-control:' + safeId(workspaceId)).digest('hex'); }
  root(userId: string, workspaceId: string) { return path.join(this.manager.config.dataRoot, safeId(userId), 'desktops', safeId(workspaceId)); }
  async info(workspaceId: string, role: 'gui' | 'control' | 'egress', userId: string) {
    try {
      const info = await this.manager.docker.getContainer(desktopNames(workspaceId)[role]).inspect();
      if (info.Config.Labels?.['cloud-work.desktop'] !== workspaceId || info.Config.Labels?.['cloud-work.user-id'] !== userId || info.Config.Labels?.['cloud-work.desktop-role'] !== role) throw new Error('Desktop ownership mismatch');
      return info;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async connect(network: string, container: string) {
    const net = this.manager.docker.getNetwork(network), info = await net.inspect();
    const target = await this.manager.docker.getContainer(container).inspect();
    if (!info.Containers?.[target.Id]) await net.connect({ Container: target.Id });
  }
  async network(name: string, workspaceId: string, internal: boolean) {
    try {
      const info = await this.manager.docker.getNetwork(name).inspect();
      if (info.Labels?.['cloud-work.desktop'] !== workspaceId || info.Internal !== internal) throw new Error('Desktop network ownership mismatch');
    } catch (error) {
      if (!missing(error)) throw error;
      await createPooledNetwork(this.manager.docker, { Name: name, Internal: internal, Labels: { 'cloud-work.desktop': workspaceId }, ...(internal ? { Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } } : {}) }, process.env.DESKTOP_NETWORK_POOL || '10.245.0.0/16');
    }
  }
  async ensure(userId: string, workspaceId: string, busy: boolean) {
    const names = desktopNames(workspaceId), docker = this.manager.docker;
    const root = this.root(userId, workspaceId), workspace = path.join(this.manager.config.dataRoot, userId, 'workspaces', workspaceId);
    if (await realpath(workspace) !== workspace || !(await lstat(workspace)).isDirectory()) throw new Error('Workspace mount is not a real directory');
    // Validate each ancestor: never follow a writable symlink while creating platform state.
    for (const dir of [path.dirname(root), root, path.join(root, 'config')]) {
      await mkdir(dir, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) throw new Error('Desktop data path must not contain symlinks');
    }
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize < 256 * 1024 * 1024) throw new HttpError(507, 'Insufficient desktop storage', 'DESKTOP_STORAGE_FULL');
    await chown(root, 1000, 1000); await chown(path.join(root, 'config'), 1000, 1000);
    await chmod(root, 0o700);
    const seccomp = JSON.stringify(JSON.parse(await readFile(new URL('../../../docker/desktop/seccomp.json', import.meta.url), 'utf8')));
    const blockedNetworks = (await docker.listNetworks()).flatMap(network => network.IPAM?.Config?.map(config => config.Subnet).filter((subnet): subnet is string => Boolean(subnet && !subnet.includes(':'))) ?? []).sort();
    const specs = [
      { role: 'gui' as const, image: process.env.DESKTOP_IMAGE || 'cloud-work-desktop:latest', user: '1000:1000', binds: [`${workspace}:/workspace:rw`, `${root}/config:/home/node/.config:rw`, `${names.socket}:/tmp/.X11-unix:rw`], env: [`CHROMIUM_PROXY=http://${names.egress}:3128`, `HTTP_PROXY=http://${names.egress}:3128`, `HTTPS_PROXY=http://${names.egress}:3128`], networks: [names.network], memory: 4096, cpus: 2, pids: 512 },
      { role: 'control' as const, image: process.env.DESKTOP_CONTROL_IMAGE || 'cloud-work-desktop-control:latest', user: '1001:1001', binds: [`${names.socket}:/tmp/.X11-unix:ro`], env: [`DESKTOP_CONTROL_TOKEN=${this.token(workspaceId)}`], networks: [names.network, names.private], memory: 512, cpus: 1, pids: 128 },
      { role: 'egress' as const, image: process.env.DESKTOP_EGRESS_IMAGE || 'cloud-work-desktop-egress:latest', user: '1001:1001', binds: [], env: ['PORT=3128', `DESKTOP_ALLOWED_ORIGINS=${process.env.DESKTOP_ALLOWED_ORIGINS || ''}`, `DESKTOP_ALLOWED_PRIVATE_IPS=${process.env.DESKTOP_ALLOWED_PRIVATE_IPS || ''}`, `DESKTOP_BLOCKED_NETWORKS=${blockedNetworks.join(',')}`], networks: [names.network, names.output], memory: 128, cpus: 0.25, pids: 64 },
    ];
    const images = await Promise.all(specs.map(s => docker.getImage(s.image).inspect()));
    const current = await Promise.all(specs.map(s => this.info(workspaceId, s.role, userId)));
    for (let i = 0; i < specs.length; i++) {
      const info = current[i]; if (!info) continue;
      if (specs[i]!.binds.some(bind => !info.HostConfig.Binds?.includes(bind))) throw new Error('Desktop data mounts changed; migration required');
    }
    const fingerprints = specs.map(spec => createHash('sha256').update(JSON.stringify({ ...spec, seccomp: spec.role === 'gui' ? seccomp : undefined })).digest('hex'));
    const outdated = current.some((info, i) => info && (info.Image !== images[i]!.Id || info.Config.Labels?.['cloud-work.desktop-config'] !== fingerprints[i]));
    if (outdated && !busy) {
      await this.stop(userId, workspaceId);
      // Preserve the previous browser profile before a potentially irreversible browser upgrade.
      const backup = path.join(root, 'before-upgrade-' + Date.now());
      try { await lstat(backup); throw new HttpError(409, 'Previous desktop upgrade backup requires review', 'DESKTOP_BACKUP_EXISTS'); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      await cp(path.join(root, 'config'), backup, { recursive: true, dereference: false, errorOnExist: true, force: false });
      for (const info of current) if (info) await docker.getContainer(info.Id).remove({ v: false });
      current.fill(undefined);
    }
    await this.network(names.network, workspaceId, true); await this.network(names.private, workspaceId, true); await this.network(names.output, workspaceId, false);
    await this.connect(names.private, this.manager.config.managerContainer);
    await this.connect(names.private, process.env.DESKTOP_GATEWAY_CONTAINER_NAME || 'cloud-work-desktop-gateway');
    await docker.createVolume({ Name: names.socket, Labels: { 'cloud-work.desktop': workspaceId } });
    for (const i of [2, 0, 1]) {
      const spec = specs[i]!; let info = current[i];
      if (!info) {
        const container = await docker.createContainer({ name: names[spec.role], Image: images[i]!.Id, User: spec.user,
          Labels: { 'cloud-work.desktop': workspaceId, 'cloud-work.user-id': userId, 'cloud-work.desktop-role': spec.role, 'cloud-work.desktop-config': fingerprints[i]! }, Env: spec.env,
          HostConfig: { Binds: spec.binds, Init: true, Memory: spec.memory * 1024 ** 2, NanoCpus: spec.cpus * 1e9, PidsLimit: spec.pids, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true', ...(spec.role === 'gui' ? ['seccomp=' + seccomp] : [])], ShmSize: 256 * 1024 ** 2, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,nosuid,size=256m', '/home/node': 'rw,nosuid,size=32m,uid=1000,gid=1000' }, RestartPolicy: { Name: 'unless-stopped' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } },
          NetworkingConfig: { EndpointsConfig: Object.fromEntries(spec.networks.map(network => [network, { Aliases: [names[spec.role]], GwPriority: network === names.output ? 1 : 0 }])) },
        });
        info = await container.inspect();
      }
      if (!info.State.Running) await docker.getContainer(info.Id).start();
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await this.request(workspaceId, '/health'); return images[0]!.Id; }
      catch { if (attempt === 59) throw new HttpError(503, 'Desktop did not become ready', 'DESKTOP_UNAVAILABLE'); await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    throw new Error('Desktop unavailable');
  }
  async request(workspaceId: string, endpoint: string, data?: unknown): Promise<Response> {
    const response = await fetch(`http://${desktopNames(workspaceId).control}:8080${endpoint}`, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + this.token(workspaceId), 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(409, 'Desktop control was lost or interrupted', 'DESKTOP_CONTROL_LOST'); }
    return response;
  }
  async stop(userId: string, workspaceId: string) {
    for (const role of ['control', 'gui', 'egress'] as const) {
      const info = await this.info(workspaceId, role, userId);
      if (info?.State.Running) await this.manager.docker.getContainer(info.Id).stop({ t: 5 });
    }
  }
  async purge(userId: string, workspaceId: string) {
    await this.stop(userId, workspaceId);
    const names = desktopNames(workspaceId);
    for (const role of ['control', 'gui', 'egress'] as const) { const info = await this.info(workspaceId, role, userId); if (info) await this.manager.docker.getContainer(info.Id).remove({ v: false }); }
    for (const name of [names.private, names.network, names.output]) {
      try {
        const network = this.manager.docker.getNetwork(name), info = await network.inspect();
        if (info.Labels?.['cloud-work.desktop'] !== workspaceId) throw new Error('Network ownership mismatch');
        for (const id of Object.keys(info.Containers ?? {})) await network.disconnect({ Container: id });
        await network.remove();
      } catch (error) { if (!missing(error)) throw error; }
    }
    try { const volume = this.manager.docker.getVolume(names.socket); if ((await volume.inspect()).Labels?.['cloud-work.desktop'] !== workspaceId) throw new Error('Volume ownership mismatch'); await volume.remove(); } catch (error) { if (!missing(error)) throw error; }
    const root = this.root(userId, workspaceId);
    try { if (await realpath(root) !== root) throw new Error('Unsafe desktop data path'); await rm(root, { recursive: true }); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
}
