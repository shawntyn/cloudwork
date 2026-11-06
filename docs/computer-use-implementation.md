# Computer Use integration

Accepted contract: preserve existing Cloud Work features and ordinary concurrent DSH messages. A computer tool invocation or explicit desktop open starts a workspace desktop; receiving a message alone never starts it. Only desktop users contend for a desktop lease. Manual takeover cancels only the owning run, not unrelated sessions.

## Architecture

- PostgreSQL owns desktop/task/action state; manager owns Docker and run admission.
- DSH receives a per-run internal computer tool grant. Asynchronous start/status/cancel tools avoid long RPC calls. Tools are an internal platform capability, separate from user MCP connections.
- A computer runner receives a task-scoped grant and invokes a configured vision model. It cannot access Docker, database, user MCP secrets, or other tasks.
- Desktop GUI runs as uid 1000, trusted control in a separate container as uid 1001. Only the workspace is shared with GUI; control credentials never enter GUI environment.
- Same-origin gateway authenticates viewers through Web on connection and periodically afterwards. Read-only VNC is enforced by a trusted server, not the browser flag. Input requires an epoch-bound tab owner.
- Public-network egress only through a pinned-address proxy. DSH sandbox remains offline.
- Unknown effects are never replayed; parent run termination revokes child tasks; continuation is a new request.

## Delivery checklist

- [ ] Protocol, database migration, durable control and action fencing
- [ ] Desktop image, controller, egress and manager lifecycle
- [ ] Internal computer tools, visual runner, cancellation and recovery
- [ ] Authenticated VNC gateway and viewer
- [ ] Localized UI, on-demand start, takeover/release/continuation
- [ ] Deletion, retention, idle reaping, upgrade preservation
- [ ] Behavioral regression, full typecheck/build/test, Docker and UI verification

This file tracks implementation; unchecked entries are not claims of completion.
