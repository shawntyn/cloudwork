# Computer migration verification

This record is updated as checks finish. It does not imply unrun checks passed.

- Existing unit/contract suites passed after internal computer grant integration.
- Workspace TypeScript checks passed after adding manager, controller, gateway,
  runner and UI packages.
- Scoped token tampering/expiry, input bounds and exact confirmation schema passed.
- Egress public DNS pinning, mixed/private DNS rejection, exact intranet exception,
  blocked platform CIDRs and loopback rejection passed.
- Chromium sandbox probe passed on this Docker host with UID 1000, capabilities
  dropped, no-new-privileges and the desktop seccomp profile. No --no-sandbox.
- The isolated Docker stack built and started. Authenticated read-only VNC,
  tab-scoped manual control and release, and cross-account rejection passed.
- With a deterministic model fixture, ordinary DSH messages left the desktop
  stopped. A delegated task captured screenshots, operated Chromium, and
  downloaded a file verified through the workspace API. The file survived a
  desktop stop and restart.
- Live inference against the original intranet gateway remains unverified
  because the gateway is unreachable from the current network.
- The final Docker rebuild, post-fix UI matrix and production rollout remain
  pending. Automatic approval review declined to execute the rebuild due to
  the approval service usage limit.
