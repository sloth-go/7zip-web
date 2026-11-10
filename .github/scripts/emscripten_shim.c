// Emscripten/wasm shim for the 7-Zip 7zz console build.
//
// The browser sandbox does not implement the Linux sysinfo() call that
// 7-Zip's POSIX code path references from CPP/Windows/System.cpp
// (GetRamSize(): used for dictionary sizing / memory estimates).
// We provide a safe stand-in instead of patching upstream sources:
// report a conservative 2 GiB (typical wasm32 heap budget).

#include <sys/sysinfo.h>
#include <string.h>

int sysinfo(struct sysinfo *info)
{
    if (!info)
        return -1;
    memset(info, 0, sizeof(*info));
    info->totalram  = 2147483648UL;  // 2 GiB
    info->freeram   = 1073741824UL;  // 1 GiB "free"
    info->procs = 1;
    info->mem_unit  = 1;
    return 0;
}

// Emscripten's __syscall_umask stub (system/lib/libc/emscripten_syscall_stubs.c)
// initializes the process umask to 0777 ("mask nothing away" reading).
// 7-Zip's C_umask global constructor (CPP/Windows/FileDir.cpp) computes
//     mask = ~umask(0) & 0777
// at startup, which then yields 0 — and extraction applies
//     mode_for_Create = (unix_attribs >> 16) & mask
// so every extracted file gets mode 0000 and the emscripten FS rejects the
// follow-up write with EACCES. Override umask() with classic POSIX semantics
// and the conventional 0022 default; the shim object overrides musl's
// libc.a member at link time.

#include <sys/stat.h>

static mode_t shim_current_umask = 0022;

mode_t umask(mode_t mask)
{
    mode_t old = shim_current_umask;
    shim_current_umask = mask & 0777;
    return old;
}
