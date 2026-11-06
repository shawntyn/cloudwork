import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { planSchema, terminalTask } from '@cloud-work/computer';
import { plan } from './model.js';
const base = process.env.RUNTIME_MANAGER_URL || 'http://runtime-manager:4000';
const workerToken = process.env.COMPUTER_RUNNER_TOKEN ?? '';
if (workerToken.length < 32) throw new Error('Computer runner token is required');
const runnerId = 'runner_' + randomUUID();
let stopped = false;
const controllers = new Set<AbortController>();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function request(token: string, route: string, data: unknown = {}, signal?: AbortSignal) {
  const response = await fetch(base + route, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(data), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('COMPUTER_CONTROL_HTTP_' + response.status); }
  return response;
}
interface Task { id: string; goal: string; token: string; actionCount: number; deadline: string }
interface State { state: string; actionCount: number; instructions: Array<{ id: string; text: string }>; confirmation: null | { id: string; approved?: boolean; kind: string; operation: unknown; reason: string } }
async function run(task: Task) {
  const controller = new AbortController(); controllers.add(controller);
  let state: State | undefined, heartbeatPending = false;
  const history: string[] = [], seenInstructions = new Set<string>(), usedApprovals = new Set<string>();
  let sequence = task.actionCount, repeat = 0, last = '', lastFrame = '';
  const call = (route: string, data?: unknown) => request(task.token, '/computer/task/' + route, data ?? {}, controller.signal);
  const heartbeat = async () => {
    if (heartbeatPending) return; heartbeatPending = true;
    try { state = await (await call('heartbeat')).json() as State; if (terminalTask(state.state)) controller.abort(); }
    catch (error) { controller.abort(error); }
    finally { heartbeatPending = false; }
  };
  const timer = setInterval(() => { void heartbeat(); }, 3000); timer.unref();
  try {
    await heartbeat();
    while (!controller.signal.aborted && Date.now() < new Date(task.deadline).getTime()) {
      for (const instruction of state?.instructions ?? []) if (!seenInstructions.has(instruction.id)) { history.push('Additional user instruction: ' + instruction.text); seenInstructions.add(instruction.id); }
      if (state?.state === 'confirmation') { await pause(1000); continue; }
      const screenshot = Buffer.from(await (await call('screenshot')).arrayBuffer());
      let operation: import('@cloud-work/computer').ComputerAction;
      if (state?.confirmation?.approved && !usedApprovals.has(state.confirmation.id)) {
        const confirmation = state.confirmation;
        // Approval is for an exact operation. Changes to the desktop invalidate it.
        if (createHash('sha256').update(screenshot).digest('hex') !== lastFrame) throw new Error('COMPUTER_CONFIRMATION_SCREEN_CHANGED');
        const parsed = planSchema.parse({ kind: 'confirmation', reason: confirmation.reason, operation: confirmation.operation });
        if (parsed.kind !== 'confirmation') throw new Error('Invalid confirmation');
        operation = parsed.operation; usedApprovals.add(confirmation.id);
      } else {
        const response = await plan(task.goal, history, screenshot, controller.signal);
        controller.signal.throwIfAborted();
        const next = response.plan;
        await call('progress', { text: next.kind === 'action' ? next.explanation : next.kind === 'done' ? next.result.slice(0, 2000) : next.reason, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
        if (next.kind === 'done') { await call('complete', { success: true, result: next.result }); return; }
        if (next.kind === 'confirmation' || next.kind === 'handoff') {
          lastFrame = createHash('sha256').update(screenshot).digest('hex');
          await call('confirmation', next); await heartbeat(); continue;
        }
        operation = next.operation;
      }
      const signature = JSON.stringify(operation); repeat = signature === last ? repeat + 1 : 0; last = signature;
      if (repeat >= 3) throw new Error('COMPUTER_REPEATED_ACTION');
      await call('action', { sequence: ++sequence, operation });
      history.push(JSON.stringify({ sequence, operation, outcome: 'executed; verify in next screenshot' }));
      await pause(350);
    }
    controller.signal.throwIfAborted(); throw new Error('COMPUTER_TIME_BUDGET');
  } catch (error) {
    // Never retry an action with an ambiguous transport result.
    const code = error instanceof Error && /^COMPUTER_[A-Z_0-9]+$/.test(error.message) ? error.message : 'COMPUTER_INTERRUPTED';
    await request(task.token, '/computer/task/complete', { success: false, result: code }).catch(() => {});
  } finally { clearInterval(timer); controllers.delete(controller); }
}
async function work() {
  while (!stopped) {
    try {
      const response = await request(workerToken, '/computer/worker/claim', { runnerId });
      const { task } = await response.json() as { task: Task | null };
      if (task) await run(task); else await pause(2000);
    } catch { await pause(3000); }
  }
}
const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: !stopped, active: controllers.size })));
server.listen(4200, '0.0.0.0');
for (let index = 0; index < Math.min(8, Math.max(1, Number(process.env.COMPUTER_CONCURRENCY || 2))); index++) void work();
process.on('SIGTERM', () => { stopped = true; for (const controller of controllers) controller.abort(); server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
