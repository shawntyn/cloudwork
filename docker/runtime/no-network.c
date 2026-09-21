/* Install an inherited Linux seccomp boundary only in a tool subprocess.
 * Compile statically: loader environment must not run code before the filter.
 * The DSH parent remains online; no proxy variables or cooperative checks are used.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#else
#error "Cloud Work network sandbox supports Linux x86_64 and aarch64 only"
#endif

#define DENY_SYSCALL(number) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static void fail(const char *operation) {
    fprintf(stderr, "cloud-work-no-network: %s: %s\n", operation, strerror(errno));
    exit(126);
}

static void confine(void) {
    /* Node/libuv uses AF_UNIX socketpairs for some stdio pipes. Preserve only
     * those fixed IPC endpoints; never inherit an IP/network connection. */
    for (int fd = 0; fd < 3; fd++) {
        struct stat info;
        if (fstat(fd, &info) == 0 && S_ISSOCK(info.st_mode)) {
            int domain = 0;
            socklen_t length = sizeof(domain);
            if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &length) != 0 || domain != AF_UNIX) {
                errno = EPERM;
                fail("network socket supplied as standard input/output");
            }
        }
    }
    if (syscall(SYS_close_range, 3U, UINT32_MAX, 0U) != 0) fail("close inherited descriptors");
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, EXPECTED_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* The x32 ABI shares AUDIT_ARCH_X86_64 but changes syscall numbers. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
        /* All address families, including IP, UNIX proxies, packet and netlink. */
        DENY_SYSCALL(SYS_socket),
        DENY_SYSCALL(SYS_connect),
        DENY_SYSCALL(SYS_bind),
        DENY_SYSCALL(SYS_listen),
        DENY_SYSCALL(SYS_accept),
        DENY_SYSCALL(SYS_accept4),
        DENY_SYSCALL(SYS_sendto),
        DENY_SYSCALL(SYS_sendmsg),
        DENY_SYSCALL(SYS_sendmmsg),
        DENY_SYSCALL(SYS_recvfrom),
        DENY_SYSCALL(SYS_recvmsg),
        DENY_SYSCALL(SYS_recvmmsg),
        /* io_uring can perform networking without the socket syscalls above. */
        DENY_SYSCALL(SYS_io_uring_setup),
        DENY_SYSCALL(SYS_io_uring_enter),
        DENY_SYSCALL(SYS_io_uring_register),
        /* Prevent acquiring an online sibling's descriptors or injecting code. */
        DENY_SYSCALL(SYS_pidfd_getfd),
        DENY_SYSCALL(SYS_ptrace),
        DENY_SYSCALL(SYS_process_vm_writev),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("set no_new_privs");
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) fail("install seccomp network filter");
}

int main(int argc, char **argv) {
    int probe = argc == 2 && strcmp(argv[1], "--probe") == 0;
    if (!probe && (argc < 3 || strcmp(argv[1], "--") != 0)) {
        fprintf(stderr, "cloud-work-no-network: usage: --probe | -- PROGRAM [ARG ...]\n");
        return 126;
    }
    confine();
    if (probe) {
        int domains[] = { AF_INET, AF_INET6, AF_UNIX, AF_NETLINK, AF_PACKET };
        for (size_t index = 0; index < sizeof(domains) / sizeof(domains[0]); index++) {
            errno = 0;
            int fd = socket(domains[index], SOCK_DGRAM, 0);
            if (fd >= 0 || errno != EPERM) { errno = EPERM; fail("network syscall probe did not deny socket creation"); }
        }
        puts("{\"network\":\"denied\",\"mechanism\":\"seccomp\",\"noNewPrivileges\":true}");
        return 0;
    }
    /* Mutable workspace executables become visible only after confinement. */
    const char *tool_path = getenv("CLOUD_WORK_TOOL_PATH");
    if (tool_path && tool_path[0]) {
        const char *path = getenv("PATH");
        char *combined = NULL;
        if (asprintf(&combined, "%s:%s", tool_path, path ? path : "/usr/local/bin:/usr/bin:/bin") < 0) fail("allocate tool PATH");
        if (setenv("PATH", combined, 1) != 0) fail("set tool PATH");
        free(combined);
    }
    execvp(argv[2], &argv[2]);
    fail("exec command");
    return 126;
}
