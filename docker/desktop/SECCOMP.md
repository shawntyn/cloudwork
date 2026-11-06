The desktop profile in `seccomp.json` derives from Moby's default profile:
https://github.com/moby/profiles/blob/main/seccomp/default.json
Retrieved 2026-11-06. Moby profiles are licensed under Apache-2.0.

The only additional allowed calls are `clone`, `unshare`, `setns`, and `chroot`.
Chromium uses these inside its unprivileged user namespace to establish its own
sandbox. `clone3` retains the default ENOSYS fallback. The profile applies only
to the GUI container; controller, proxy and platform retain Docker's default.
The GUI still runs as uid 1000 with all outer capabilities dropped,
no-new-privileges, read-only rootfs, resource limits and an isolated network.
Chromium is never started with --no-sandbox. A deployment whose kernel does not
support unprivileged user namespaces must fix its host policy; do not disable
Chromium's sandbox to work around it.
