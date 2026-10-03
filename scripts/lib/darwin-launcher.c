// The `pi` of a macOS build: starts `pi-bin`, the Pi-Bolt executable beside it, in this same process, with ASLR off for it.
//
// An executable with a static heap must run where it was linked to be (docs/ARCHITECTURE.md, "The macOS ARM64 port"). Started
// directly, it starts again itself, once dyld has loaded it and its libraries; from here it is started that way at once, which
// saves dyld's work on the first start (about a millisecond and a half). Without this launcher it works all the same.
// Built by scripts/build-pi.sh: clang -O2 -mmacosx-version-min=13.0 darwin-launcher.c -o pi
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char** environ;

int main(int argc, char** argv)
{
    (void)argc;
    char self[PATH_MAX];
    uint32_t size = sizeof(self);
    char resolved[PATH_MAX];
    if (_NSGetExecutablePath(self, &size) || !realpath(self, resolved)) {
        fprintf(stderr, "pi: cannot tell where this executable is\n");
        return 127;
    }
    char target[PATH_MAX];
    if (snprintf(target, sizeof(target), "%s/pi-bin", dirname(resolved)) >= (int)sizeof(target)) {
        fprintf(stderr, "pi: the path of this executable is too long\n");
        return 127;
    }

    // What pi-bin's own start without ASLR looks for (c-bindings.cpp in Bun): it is started that way already.
    setenv("BUN_INTERNAL_STATIC_HEAP_NO_ASLR", "1", 1);
    posix_spawnattr_t attributes;
    if (!posix_spawnattr_init(&attributes)) {
        const short disableASLR = 0x100; // _POSIX_SPAWN_DISABLE_ASLR
        posix_spawnattr_setflags(&attributes, disableASLR | POSIX_SPAWN_SETEXEC);
        posix_spawn(NULL, target, NULL, &attributes, argv, environ);
    }
    // Not started that way: as it is (it then starts again itself, if it can).
    unsetenv("BUN_INTERNAL_STATIC_HEAP_NO_ASLR");
    execv(target, argv);
    fprintf(stderr, "pi: cannot start %s: %s\n", target, strerror(errno));
    return 127;
}
