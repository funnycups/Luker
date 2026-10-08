/**
 * node_ctl.c — NAPI module for the main (ArkTS) process.
 *
 * Two jobs:
 *   1. killNode(pid) — terminate the native-child-process node backend.
 *   2. startBackend(entryParams) — run node IN THIS (main app) PROCESS:
 *      dlopen the bundled libnode.so and call node::Start on a dedicated
 *      32MB-stack pthread (the nodejs-mobile / electron-harmony pattern).
 *
 * Why in-process: the nativespawn CHILD process runs under a stricter
 * seccomp filter than the app itself — node's libuv dies there (SIGSYS /
 * abort) because event-loop syscalls are fenced off. The MAIN app process
 * demonstrably runs libuv-class loops (NETSTACK/curl, the ArkTS runtime),
 * so node lives there. electron-harmony works the same way: its node core
 * ships as .so libraries inside the app process, never a spawned binary.
 *
 * Everything is logged to <dataDir>/node-boot.log (same file the child
 * launcher writes) and to hilog (tag luker.embed), so the on-screen
 * boot-log overlay shows this path's ladder exactly like the child's.
 *
 * Returns "ok" synchronously once the node thread is launched; on any
 * failure returns "err:<reason>" so ArkTS can fall back to the native
 * child process.
 *
 * Attribution: the in-process Node launcher here is derived from
 * electerm-harmony's entry/src/main/cpp/node_ctl.c
 * (https://github.com/electerm/electerm-harmony),
 * Copyright (c) since 2017~ ZHAO Xudong <zxdong@gmail.com>, MIT licensed.
 * The full license text is in harmony-app/THIRD_PARTY_NOTICES.md.
 */

#include "napi/native_api.h"

#include <dlfcn.h>
#include <errno.h>
#include <execinfo.h>
#include <fcntl.h>
#include <link.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <ucontext.h>
#include <unistd.h>
#include <hilog/log.h>

#define LOG_BUF_SIZE 4096
#define MAX_ENV_VARS 32
#define MAX_LINE 1024
#define MAX_CANDIDATES 12

/* F_SETPIPE_SZ — present in the OHOS NDK headers on newer SDKs only. */
#ifndef F_SETPIPE_SZ
#define F_SETPIPE_SZ 1031
#endif

typedef struct {
  char dataDir[MAX_LINE];    /* writable app data dir (el2 filesDir) */
  char script[MAX_LINE * 2]; /* path to resfile/luker/bootstrap.js */
  char node[MAX_LINE * 2];   /* optional parent-provided libnode.so path */
  char port[16];
  char secret[MAX_LINE]; /* SERVER_SECRET */
} CtlConfig;

static int g_logFd = -1;
static char g_logPath[MAX_LINE * 2] = "";
static int g_started = 0; /* startBackend may only run once per process */
static int g_pipeOut = -1; /* read end of the stdio→hilog pipe */

/* ── Launch status plumbing ──────────────────────────────────────────────
 * The expensive work (dlopen of the ~120MB libnode.so with RTLD_NOW, dlsym,
 * node::Start) runs on a background thread, so startBackend() returns as
 * soon as that thread exists. The ArkTS side polls getBackendStatus() while
 * it probes http://127.0.0.1:8000, so a HARD failure (script missing, no
 * libnode.so, dlopen/dlsym failed) is detectable in milliseconds instead of
 * after the whole boot timeout — and the page can then fall back to the
 * native child process instead of sitting on the splash screen.
 * ──────────────────────────────────────────────────────────────────────── */
#define ST_LAUNCHING 1
#define ST_RUNNING 2
#define ST_FAILED 3

static volatile int g_status = 0; /* 0 = not started */
static char g_statusDetail[160] = ""; /* written BEFORE g_status is set */

static void setStatus(int code, const char *detail) {
  if (detail && detail[0]) {
    snprintf(g_statusDetail, sizeof(g_statusDetail), "%s", detail);
  } else {
    g_statusDetail[0] = '\0';
  }
  __atomic_store_n(&g_status, code, __ATOMIC_RELEASE);
}

static int getStatusCode(void) {
  return __atomic_load_n(&g_status, __ATOMIC_ACQUIRE);
}

static void logWrite(const char *fmt, ...);

/* ArkWeb/chromium logs to the same process-level stdout/stderr we redirected
 * for node — at thousands of lines it buries node's output in node-boot.log
 * and in the on-screen overlay. Skip the known framework prefixes so what
 * remains (node console output, asserts, stack traces) stays readable. */
static int isFrameworkNoise(const char *s) {
  static const char *pref[] = {
    "[nweb",       "[render_",     "[browser_contents", "[arkweb_",
    "[extension_u", "[res_",       "[frame_",           "[disk_cache",
    "[sys_info_u", "[inputmethod", "[chrome",           "[content::",
    "[media/",     "[gpu_",        "[vulkan",           "[webview",
    "[crashpad",   "[mojo",        "[viz",              "[cc::",
    "[net::",      "[base::",      "[ipc_",             "[tracing/",
    "[skia",       "[snapshot",    "CefRender",         "PRPPreload",
    "OnFirstScreenPaint", "[nwebspawn", "[sandbox", "[audio_",
    NULL
  };
  for (int i = 0; pref[i]; i++) {
    if (strncmp(s, pref[i], strlen(pref[i])) == 0) return 1;
  }
  static const char *frag[] = {
    "web render log", "SubmitCompositorFrame", "LocalSurfaceId",
    "OnScaleInited", "invokeVisualStateCallback", "OnPageVisible",
    "OldPageNoLongerRendered", "SetUseSpecifiedDeadline", "cloud control",
    "cloud_control", "safe browsing", "safe_browsing", "ua config",
    "version.txt open failed", "SIGSYS needs to be reserved",
    "Starting update check", "Finished update check", NULL
  };
  for (int i = 0; frag[i]; i++) {
    if (strstr(s, frag[i])) return 1;
  }
  return 0;
}

/* ArkWeb/Chromium logs in its "[file.cc:123] message" shape. Matching the
 * shape covers the whole family the prefix list above cannot enumerate
 * (shared_image_util.cc, d_vsync_controller.cc, ...). Node and Luker output
 * never takes this shape: "[card-app] ..." has no colon and
 * "[2026-10-07T17:20:48.261Z] ..." has non-digits after its last colon. */
static int isChromiumSourceLine(const char *s) {
  if (s[0] != '[') return 0;
  const char *end = strchr(s, ']');
  if (!end) return 0;
  const char *colon = NULL;
  for (const char *p = s + 1; p < end; p++) {
    if (*p == ':') colon = p;
  }
  if (!colon || colon + 1 >= end) return 0;
  for (const char *p = colon + 1; p < end; p++) {
    if (*p < '0' || *p > '9') return 0;
  }
  for (const char *p = s + 1; p < colon; p++) {
    if (*p == '.') return 1;
  }
  return 0;
}

/* Drain the app's stdout/stderr (fd 1/2 are dup2'd onto a pipe) — FAST and
 * BOUNDED. This is the single most important invariant in the file.
 *
 * The pipe is fed by EVERYTHING in the process, not just node: ArkWeb /
 * Chromium logs thousands of lines per second to the same fd 1/2. Doing any
 * per-line work that costs more than a memcmp — an OH_LOG_Print (an IPC to
 * hilogd), an snprintf, a formatted write — lets the pipe fill up. The next
 * writer then BLOCKS: Chromium's logging thread, node's abort(), or a
 * signal handler. With Chromium's IO thread blocked the Web component never
 * paints, which is exactly how the app used to sit on its splash screen
 * until the ANR watchdog killed it.
 *
 * So the reader:
 *   1. always drains (never lets a writer block) — an 8KB read per loop;
 *   2. filters framework noise with cheap strncmp/strstr only;
 *   3. writes surviving lines to the boot log with a raw write() (one
 *      syscall per line, no formatting, no locks);
 *   4. hilog's only lines that are not Chromium "[file.cc:N]" logs. Those
 *      are the high-rate source; what remains is node's own output, which
 *      testers can only report through hilog, so it is printed public and
 *      unthrottled.
 */
static void *stdioReaderThread(void *p) {
  (void)p;
  char buf[8192];
  char line[480];
  size_t linelen = 0;

  for (;;) {
    ssize_t r = read(g_pipeOut, buf, sizeof(buf));
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) break;
    for (ssize_t i = 0; i < r; i++) {
      char c = buf[i];
      if (c == '\n' || linelen >= sizeof(line) - 1) {
        line[linelen] = '\0';
        if (linelen > 0) {
          if (isFrameworkNoise(line)) {
            /* dropped on the floor — the only correct thing to do with
             * thousands of Chromium lines a second. */
          } else {
            /* Raw write: no vsnprintf, no libc stdio locks. */
            if (g_logFd >= 0) {
              ssize_t ign = write(g_logFd, line, linelen);
              ign = write(g_logFd, "\n", 1);
              (void)ign;
            }
            if (!isChromiumSourceLine(line)) {
              (void)OH_LOG_Print(LOG_APP, LOG_ERROR, 0xE1EC,
                                 "luker.embed", "[io] %{public}s", line);
            }
          }
        }
        linelen = 0;
      } else if (c != '\r' && c != '\0') {
        line[linelen++] = c;
      }
    }
  }
  return NULL;
}

static void logWrite(const char *fmt, ...) {
  char buf[LOG_BUF_SIZE];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf) - 1, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  buf[n] = '\0';
  if (g_logFd >= 0) {
    ssize_t ignored = write(g_logFd, buf, (size_t)n);
    ignored = write(g_logFd, "\n", 1);
    (void)ignored;
  }
  (void)OH_LOG_Print(LOG_APP, LOG_ERROR, 0xE1EC, "luker.embed",
                     "%{public}s", buf);
}

/* ── Crash markers — name the killer signal in the boot log AND hilog (the
 * process may die right after; hilog keeps the line). If the signal came
 * from node's own thread, PARK that thread instead of dying: the app UI
 * process survives, the ArkTS probe times out and the on-screen overlay
 * shows the boot-log tail — instead of the app just closing. ── */
static pid_t g_nodeTid = 0; /* tid of the node thread once launched */

static void crashMarkerHandler(int sig, siginfo_t *si, void *ctx) {
  int saved = errno;
  long tid = (long)syscall(__NR_gettid);
  ucontext_t *uc = (ucontext_t *)ctx;
  unsigned long pc = 0, sp = 0, lr = 0, arg0 = 0;

#if defined(__aarch64__)
  if (uc) {
    pc = uc->uc_mcontext.pc;
    sp = uc->uc_mcontext.sp;
    lr = uc->uc_mcontext.regs[30];
    arg0 = uc->uc_mcontext.regs[0];
  }
#elif defined(__x86_64__)
  if (uc) {
    pc = (unsigned long)uc->uc_mcontext.gregs[REG_RIP];
    sp = (unsigned long)uc->uc_mcontext.gregs[REG_RSP];
    arg0 = (unsigned long)uc->uc_mcontext.gregs[REG_RAX];
  }
#endif

  char b[128];
  int n = snprintf(b, sizeof(b), "[embed] fatal: signal %d on tid %ld",
                   sig, tid);
  if (n > 0) {
    if (g_logFd >= 0) {
      ssize_t ign = write(g_logFd, b, (size_t)n);
      ign = write(g_logFd, "\n", 1);
      (void)ign;
    }
    (void)OH_LOG_Print(LOG_APP, LOG_ERROR, 0xE1EC, "luker.embed",
                       "%{public}s", b);
  }

  /* The fault context. backtrace() on aarch64/musl very often returns ZERO
   * frames (it cannot unwind through the signal frame), and when that
   * happens the crash used to be completely unlocatable. The raw PC plus
   * the faulting address can always be resolved offline against the
   * unstripped libnode.so (see .workbuddy/tools/sym.py), so log them
   * FIRST — before the backtrace, which can itself abort. */
  logWrite("[embed] fault: sig=%d code=%d addr=0x%lx pc=0x%lx sp=0x%lx lr=0x%lx x0=0x%lx",
           sig, si ? si->si_code : -1,
           (unsigned long)(si ? (uintptr_t)si->si_addr : 0),
           pc, sp, lr, arg0);

  /* Capture the crashing thread's native stack. The abort text (e.g.
   * "Assertion failed: fd > STDERR_FILENO ... uv__close") names the dying
   * function but never its CALLER — that's the missing piece. libnode.so is
   * unstripped, so dladdr often resolves real symbol names. Written to the
   * boot log AND hilog (short lines survive hilog's ~140-byte truncation).
   * Not strictly async-signal-safe, but the thread is about to park/die —
   * a corrupted-stack failure here costs nothing the crash didn't already. */
  {
    void *bt[24];
    int frames = backtrace(bt, 24);
    /* Log the frame count even when it is 0: "no frames" is itself the
     * answer to "why is there no backtrace". */
    logWrite("[embed] backtrace frames=%d", frames);
    for (int i = 0; i < frames; i++) {
      Dl_info info;
      char lb[192];
      int ln;
      if (dladdr(bt[i], &info) && info.dli_fname) {
        const char *slash = strrchr(info.dli_fname, '/');
        const char *base = slash ? slash + 1 : info.dli_fname;
        ln = snprintf(lb, sizeof(lb), "[embed] bt[%d/%d] %s%s%+ld (%.40s)",
                      i, frames,
                      info.dli_sname ? info.dli_sname : "",
                      info.dli_sname ? "+" : "",
                      (long)((char *)bt[i] - (char *)info.dli_fbase),
                      base);
      } else {
        ln = snprintf(lb, sizeof(lb), "[embed] bt[%d/%d] %p", i, frames,
                      bt[i]);
      }
      if (ln <= 0) continue;
      if (g_logFd >= 0) {
        ssize_t ign = write(g_logFd, lb, (size_t)ln);
        ign = write(g_logFd, "\n", 1);
        (void)ign;
      }
      (void)OH_LOG_Print(LOG_APP, LOG_ERROR, 0xE1EC, "luker.embed",
                         "%{public}s", lb);
    }
    if (g_logFd >= 0 && frames > 0) {
      ssize_t ign = write(g_logFd, "[embed] backtrace symbols:\n", 27);
      backtrace_symbols_fd(bt, frames, g_logFd);
      (void)ign;
    }
  }
  errno = saved;
  if (g_nodeTid > 0 && tid == (long)g_nodeTid) {
    /* node's thread crashed — freeze it, keep the app alive. Never returns;
     * if the crash corrupted a libc lock the UI may eventually freeze too,
     * but the evidence is already on disk and in hilog. */
    char msg[128];
    snprintf(msg, sizeof(msg), "node thread died: signal %d at pc=0x%lx",
             sig, pc);
    /* Report the failure so the ArkTS probe stops waiting: it would
     * otherwise sit on "running" for the whole boot timeout, because
     * setStatus(ST_RUNNING) was published before node::Start and nobody
     * updated it when the thread died. Failing fast lets the page fall
     * back to the native child process immediately. */
    setStatus(ST_FAILED, msg);
    logWrite("[embed] %s — failing fast so the page can try the child process",
             msg);
    for (;;) {
      pause();
    }
  }
  signal(sig, SIG_DFL);
  raise(sig);
}

static void installCrashMarkers(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = crashMarkerHandler;
  sa.sa_flags = SA_SIGINFO;
  const int sigs[] = {SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE};
  for (size_t i = 0; i < sizeof(sigs) / sizeof(sigs[0]); i++) {
    if (sigaction(sigs[i], &sa, NULL) != 0) {
      logWrite("[embed] sigaction(%d) failed: %s", sigs[i], strerror(errno));
    }
  }
}

/* The SIGSYS shim was removed: installing a process-wide SIGSYS handler
 * collides with ArkWeb/Chromium's own seccomp-bpf SIGSYS requirement in this
 * same process (the render process logs "Existing signal handler when trying
 * to install SIGSYS. SIGSYS needs to be reserved for seccomp-bpf"), and the
 * app main process then dies from SIGSYS. See the io_uring note in
 * startEmbeddedNode. */

/* Parse "key=value\n" lines (same format the child launcher parses). */
static void parseEntryParams(const char *params, CtlConfig *cfg,
                             char extraEnv[MAX_ENV_VARS][MAX_LINE],
                             int *extraEnvCount) {
  snprintf(cfg->port, sizeof(cfg->port), "8000");
  cfg->dataDir[0] = '\0';
  cfg->script[0] = '\0';
  cfg->node[0] = '\0';
  cfg->secret[0] = '\0';

  char line[MAX_LINE];
  const char *p = params;
  while (p && *p) {
    const char *eol = strchr(p, '\n');
    size_t len = eol ? (size_t)(eol - p) : strlen(p);
    if (len >= sizeof(line)) len = sizeof(line) - 1;
    memcpy(line, p, len);
    line[len] = '\0';
    p = eol ? eol + 1 : NULL;

    char *eq = strchr(line, '=');
    if (!eq) continue;
    *eq = '\0';
    const char *key = line;
    const char *value = eq + 1;

    if (strcmp(key, "dataDir") == 0) {
      snprintf(cfg->dataDir, sizeof(cfg->dataDir), "%s", value);
    } else if (strcmp(key, "script") == 0) {
      snprintf(cfg->script, sizeof(cfg->script), "%s", value);
    } else if (strcmp(key, "node") == 0) {
      snprintf(cfg->node, sizeof(cfg->node), "%s", value);
    } else if (strcmp(key, "port") == 0) {
      snprintf(cfg->port, sizeof(cfg->port), "%s", value);
    } else if (strcmp(key, "secret") == 0) {
      snprintf(cfg->secret, sizeof(cfg->secret), "%s", value);
    } else if (*extraEnvCount < MAX_ENV_VARS) {
      snprintf(extraEnv[(*extraEnvCount)++], MAX_LINE, "%s=%s", key, value);
    }
  }
}

static void addCandidate(char (*candidates)[MAX_LINE * 2], int *n,
                         const char *dir, const char *tag) {
  if (*n >= MAX_CANDIDATES) return;
  if (!dir || !dir[0]) return;
  char path[MAX_LINE * 2];
  snprintf(path, sizeof(path), "%s/libnode.so", dir);
  for (int i = 0; i < *n; i++) {
    if (strcmp(candidates[i], path) == 0) return;
  }
  snprintf(candidates[(*n)], MAX_LINE * 2, "%s", path);
  logWrite("[embed] candidate(%s): %s", tag, candidates[(*n)]);
  (*n)++;
}

typedef int (*node_start_fn)(int argc, char *argv[]);

struct NodeThreadArgs {
  node_start_fn start;
  char *argv[6]; /* node + up to 4 flags + NULL */
  int rc;
};

static struct NodeThreadArgs g_nodeArgs;

static const char *startEmbeddedNode(const char *params);

/* ── Bootstrap thread ──
 *
 * Everything expensive happens HERE and never on the caller's thread:
 *   dlopen(libnode.so, RTLD_NOW) relocates every symbol of a ~120MB
 *   library, dlsym, and node::Start (which itself runs the whole server).
 *
 * pages/Index calls the NAPI startBackend() from aboutToAppear() — i.e. on
 * the ArkTS UI thread. Doing the dlopen there blocked the UI thread for as
 * long as the relocation took, so the Index page never painted: the window
 * stayed on its splash screen until the APP_INPUT_BLOCK watchdog fired and
 * the system ANR dialog killed the app. That is the reported symptom.
 */
static void *bootstrapMain(void *arg) {
  char *params = (char *)arg;
  startEmbeddedNode(params);
  free(params);
  return NULL;
}

static const char *startBackendAsync(const char *params) {
  static char errBuf[128];

  if (g_started) {
    return "err:already started";
  }
  g_started = 1;

  char *copy = strdup(params ? params : "");
  if (!copy) {
    snprintf(errBuf, sizeof(errBuf), "err:out of memory");
    setStatus(ST_FAILED, errBuf);
    return errBuf;
  }

  setStatus(ST_LAUNCHING, "bootstrap thread starting");
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  /* node::Start wants a big stack (V8 + the deep C++ bootstrap). */
  pthread_attr_setstacksize(&attr, 32 * 1024 * 1024);
  pthread_t th;
  int prc = pthread_create(&th, &attr, bootstrapMain, copy);
  pthread_attr_destroy(&attr);
  if (prc != 0) {
    free(copy);
    logWrite("[embed] bootstrap pthread_create failed: %s", strerror(prc));
    snprintf(errBuf, sizeof(errBuf), "err:pthread_create failed");
    setStatus(ST_FAILED, errBuf);
    return errBuf;
  }
  pthread_detach(th);
  return "launching";
}

/* ── io_uring syscall interposition ──────────────────────────────────────
 * OHOS seccomp traps io_uring_setup (425) and the framework's own SIGSYS
 * disposition then terminates the process. libuv issues it unconditionally
 * for its epoll batching ring: uv__use_io_uring() returns 1 for the
 * non-SQPOLL case before it ever consults UV_USE_IO_URING (libuv
 * src/unix/linux.c), so the environment variable cannot turn it off.
 *
 * libuv reaches the kernel through the libc syscall() symbol, so after
 * dlopen we redirect libnode.so's syscall GOT entry to a wrapper that
 * reports ENOSYS for the io_uring syscalls. libuv's uv__iou_init() reads the
 * -1 return as "io_uring unavailable" and falls back to plain epoll. Nothing
 * installs a SIGSYS handler, so there is no collision with ArkWeb/Chromium's
 * seccomp-bpf SIGSYS requirement in this same process.
 * ──────────────────────────────────────────────────────────────────────── */
static long (*g_realSyscall)(long, long, long, long, long, long, long);

static long lukerSyscall(long number, long a1, long a2, long a3, long a4,
                         long a5, long a6) {
  if (number == 425 || number == 426 || number == 427) { /* io_uring_* */
    errno = ENOSYS;
    return -1;
  }
  /* Log each distinct number once. Our wrapper runs before the real syscall,
   * so if a seccomp trap still kills the process the last logged number names
   * the trapped syscall. */
  static unsigned char seen[512];
  if (number >= 0 && number < (long)sizeof(seen) && !seen[number]) {
    seen[number] = 1;
    logWrite("[embed] syscall(%ld)", number);
  }
  return g_realSyscall(number, a1, a2, a3, a4, a5, a6);
}

/* Walk the loaded objects, find libnode.so, read its PT_DYNAMIC, and
 * overwrite the GOT slot the dynamic linker filled for syscall(). */
static int patchIouringSyscall(struct dl_phdr_info *info, size_t size,
                               void *data) {
  (void)size;
  (void)data;
  if (!info->dlpi_name || !strstr(info->dlpi_name, "libnode.so"))
    return 0;

  const ElfW(Dyn) *dyn = NULL;
  for (int i = 0; i < info->dlpi_phnum; i++)
    if (info->dlpi_phdr[i].p_type == PT_DYNAMIC)
      dyn = (const ElfW(Dyn) *)(info->dlpi_addr + info->dlpi_phdr[i].p_vaddr);
  if (!dyn) {
    logWrite("[embed] io_uring patch: no PT_DYNAMIC");
    return 0;
  }

  const ElfW(Sym) *symtab = NULL;
  const char *strtab = NULL;
  const ElfW(Rela) *jmprel = NULL;
  size_t pltrelsz = 0;
  for (const ElfW(Dyn) *d = dyn; d->d_tag != DT_NULL; d++) {
    switch (d->d_tag) {
      case DT_SYMTAB:
        symtab = (const ElfW(Sym) *)(info->dlpi_addr + d->d_un.d_ptr);
        break;
      case DT_STRTAB:
        strtab = (const char *)(info->dlpi_addr + d->d_un.d_ptr);
        break;
      case DT_JMPREL:
        jmprel = (const ElfW(Rela) *)(info->dlpi_addr + d->d_un.d_ptr);
        break;
      case DT_PLTRELSZ:
        pltrelsz = d->d_un.d_val;
        break;
    }
  }
  if (!symtab || !strtab || !jmprel || pltrelsz == 0) {
    logWrite("[embed] io_uring patch: dynamic tables missing");
    return 0;
  }

  size_t count = pltrelsz / sizeof(ElfW(Rela));
  for (size_t i = 0; i < count; i++) {
    const char *name = strtab + symtab[ELF64_R_SYM(jmprel[i].r_info)].st_name;
    if (strcmp(name, "syscall") != 0)
      continue;

    void **got = (void **)(info->dlpi_addr + jmprel[i].r_offset);
    long page = sysconf(_SC_PAGESIZE);
    void *pageStart = (void *)((uintptr_t)got & ~(uintptr_t)(page - 1));
    if (mprotect(pageStart, (size_t)page, PROT_READ | PROT_WRITE) != 0) {
      logWrite("[embed] io_uring patch: mprotect failed: %s", strerror(errno));
      return 0;
    }
    g_realSyscall = (long (*)(long, long, long, long, long, long, long))*got;
    *got = (void *)lukerSyscall;
    logWrite("[embed] io_uring patch: syscall GOT %p -> %p (was %p)",
             (void *)got, (void *)lukerSyscall, (void *)g_realSyscall);
    return 1;
  }

  logWrite("[embed] io_uring patch: syscall GOT entry not found");
  return 0;
}

static const char *startEmbeddedNode(const char *params) {
  static char errBuf[256];

  char extraEnv[MAX_ENV_VARS][MAX_LINE];
  int extraEnvCount = 0;
  CtlConfig cfg;
  parseEntryParams(params, &cfg, extraEnv, &extraEnvCount);

  /* boot log — same file the child launcher uses, so the ArkTS overlay and
   * hilog dump cover both paths. Truncated per attempt: the overlay only
   * shows the last lines, and hilog keeps the history anyway. el2 junction
   * fallback like the child. */
  if (cfg.dataDir[0]) {
    char logPath[MAX_LINE * 2];
    char prevPath[MAX_LINE * 2];
    snprintf(logPath, sizeof(logPath), "%s/node-boot.log", cfg.dataDir);
    snprintf(prevPath, sizeof(prevPath), "%s/node-boot.prev.log", cfg.dataDir);
    /* Preserve the previous attempt's log before truncating. A crash kills the
     * process before the ArkTS overlay can export anything, and this file is
     * the only place the raw node output and the SIGSYS shim's [embed] SIGSYS
     * line land. Renaming keeps exactly the last (crashed) run for the next
     * export, while hilog remains the fallback when a launch never reaches
     * this code. */
    if (access(logPath, F_OK) == 0) {
      rename(logPath, prevPath);
    }
    g_logFd = open(logPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (g_logFd < 0) {
      snprintf(logPath, sizeof(logPath),
               "/data/storage/el2/base/files/luker-data/node-boot.log");
      snprintf(prevPath, sizeof(prevPath),
               "/data/storage/el2/base/files/luker-data/node-boot.prev.log");
      if (access(logPath, F_OK) == 0) {
        rename(logPath, prevPath);
      }
      g_logFd = open(logPath, O_WRONLY | O_CREAT | O_APPEND, 0644);
    }
    if (g_logFd >= 0) {
      snprintf(g_logPath, sizeof(g_logPath), "%s", logPath);
    }
  }
  logWrite("[embed] startBackend: pid=%d params=%s", (int)getpid(), params);

  if (!cfg.script[0] || access(cfg.script, F_OK) != 0) {
    logWrite("[embed] FATAL: script missing: %s", cfg.script);
    snprintf(errBuf, sizeof(errBuf), "err:script missing");
    setStatus(ST_FAILED, errBuf);
    return errBuf;
  }

  /* locate libnode.so — parent-provided path, then this .so's own dir
   * (libnode_ctl.so and libnode.so sit in the same app libs dir), then the
   * el1/bundle junction layouts. */
  char candidates[MAX_CANDIDATES][MAX_LINE * 2];
  int nCand = 0;
  if (cfg.node[0]) {
    snprintf(candidates[nCand], MAX_LINE * 2, "%s", cfg.node);
    logWrite("[embed] candidate(parent): %s", candidates[nCand]);
    nCand++;
  }
  {
    Dl_info info;
    if (dladdr((void *)&startEmbeddedNode, &info) && info.dli_fname &&
        info.dli_fname[0]) {
      const char *slash = strrchr(info.dli_fname, '/');
      if (slash) {
        char dir[MAX_LINE * 2];
        snprintf(dir, sizeof(dir), "%.*s", (int)(slash - info.dli_fname),
                 info.dli_fname);
        addCandidate(candidates, &nCand, dir, "dladdr");
      }
    }
  }
  {
    const char *bundleDir = "/data/storage/el1/bundle";
    char dir[MAX_LINE * 2];
    snprintf(dir, sizeof(dir), "%s/entry/libs/arm64-v8a", bundleDir);
    addCandidate(candidates, &nCand, dir, "el1");
    snprintf(dir, sizeof(dir), "%s/entry/libs/arm64", bundleDir);
    addCandidate(candidates, &nCand, dir, "el1");
    snprintf(dir, sizeof(dir), "%s/entry/libs/x86_64", bundleDir);
    addCandidate(candidates, &nCand, dir, "el1");
    snprintf(dir, sizeof(dir), "%s/libs/arm64-v8a", bundleDir);
    addCandidate(candidates, &nCand, dir, "el1");
    snprintf(dir, sizeof(dir), "%s/libs/x86_64", bundleDir);
    addCandidate(candidates, &nCand, dir, "el1");
  }

  const char *nodePath = NULL;
  for (int i = 0; i < nCand; i++) {
    if (access(candidates[i], F_OK) == 0) {
      nodePath = candidates[i];
      break;
    }
    logWrite("[embed] candidate not found: %s", candidates[i]);
  }
  if (!nodePath) {
    logWrite("[embed] FATAL: no libnode.so candidate exists (tried %d)", nCand);
    snprintf(errBuf, sizeof(errBuf), "err:no libnode.so");
    setStatus(ST_FAILED, errBuf);
    return errBuf;
  }
  logWrite("[embed] node binary: %s", nodePath);

  /* environment */
  setenv("NODE_ENV", "production", 1);
  setenv("HOST", "127.0.0.1", 1);
  setenv("PORT", cfg.port, 1);
  setenv("LUKER_DATA_ROOT", cfg.dataDir, 1);
  if (cfg.secret[0]) {
    setenv("SERVER_SECRET", cfg.secret, 1);
  }
  for (int i = 0; i < extraEnvCount; i++) {
    /* setenv() COPIES the value. putenv() would store a pointer into
     * `extraEnv`, a stack array of THIS frame — and since node now runs on
     * a thread that outlives startBackend, that stack is long gone by the
     * time libuv/node reads it. getenv() would then strlen() recycled
     * stack memory: a SEGV from inside uv_loop_init. */
    char *eq = strchr(extraEnv[i], '=');
    if (!eq) continue;
    *eq = '\0';
    setenv(extraEnv[i], eq + 1, 1);
  }

  /* Guarantee fds 0/1/2 are open before anything node-related runs. libuv's
   * uv__close() asserts fd > STDERR_FILENO — if the app process was spawned
   * with a closed std fd, pipe() below hands back fd 0/1, dup2() then
   * no-ops (dup2(x,x)) and close() re-closes it, and every later cleanup
   * path closes a std fd → assert. /dev/null onto any EBADF fd, and log
   * the before/after so the device log shows the real fd layout. */
  {
    char fix[96];
    int off = 0;
    for (int fd = 0; fd <= 2; fd++) {
      struct stat st;
      if (fstat(fd, &st) == 0) continue;
      int nfd = open("/dev/null", O_RDWR);
      if (nfd < 0) {
        logWrite("[embed] std fd %d closed, /dev/null open failed: %s", fd,
                 strerror(errno));
        continue;
      }
      if (nfd != fd) {
        dup2(nfd, fd);
        close(nfd);
      }
      off += snprintf(fix + off, sizeof(fix) - (size_t)off, " fd%d=/dev/null",
                      fd);
      if (off >= (int)sizeof(fix) - 16) break;
    }
    if (off > 0) {
      logWrite("[embed] stdio repair:%s", fix);
    }
  }

  /* node's stderr must be observable or abort()/assert messages vanish:
   * redirect fd 1/2 onto a pipe and stream it line-by-line to the boot log
   * AND hilog (hilog truncates long messages, so file-only capture is not
   * readable in cloud debug). The reader thread keeps draining so framework
   * printf traffic (ArkWeb config spam) can never block a writer. */
  installCrashMarkers();
  setenv("UV_USE_IO_URING", "0", 1); /* covers the SQPOLL path; the ctl ring is GOT-patched below */
  if (g_logFd > 2) {
    int fds[2];
    if (pipe(fds) == 0) {
      /* 1MB, up from the default 64KB: ArkWeb/Chromium shares this pipe and
       * logs thousands of lines per second. A 64KB buffer fills in
       * milliseconds whenever the reader is descheduled, and every writer
       * that hits a full pipe blocks. */
      int pipeSz = fcntl(fds[0], F_SETPIPE_SZ, 1024 * 1024);
      logWrite("[embed] stdio pipe: read=%d write=%d size=%d", fds[0], fds[1],
               pipeSz);
      g_pipeOut = fds[0];
      dup2(fds[1], 1);
      dup2(fds[1], 2);
      close(fds[1]);
      pthread_t rd;
      pthread_attr_t ra;
      pthread_attr_init(&ra);
      pthread_attr_setstacksize(&ra, 256 * 1024);
      if (pthread_create(&rd, &ra, stdioReaderThread, NULL) == 0) {
        pthread_detach(rd);
        logWrite("[embed] stdio piped: reader streaming to boot log + hilog");
      } else {
        logWrite("[embed] reader thread failed: %s", strerror(errno));
      }
    } else {
      dup2(g_logFd, 1);
      dup2(g_logFd, 2);
      logWrite("[embed] stdout/stderr redirected to node-boot.log");
    }
  }

  if (cfg.dataDir[0] && chdir(cfg.dataDir) == 0) {
    logWrite("[embed] cwd: %s", cfg.dataDir);
  }

  logWrite("[embed] in-process(main): dlopen(%s)", nodePath);
  void *h = dlopen(nodePath, RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    /* retry by bare name — the linker namespace search path contains the
     * app libs dir even when an absolute-path dlopen is refused */
    const char *e1 = dlerror();
    logWrite("[embed] dlopen(abs) failed: %s — retrying bare name", e1 ? e1 : "?");
    h = dlopen("libnode.so", RTLD_NOW | RTLD_LOCAL);
    if (!h) {
      const char *e2 = dlerror();
      logWrite("[embed] dlopen failed: %s / %s", e1 ? e1 : "-", e2 ? e2 : "-");
      snprintf(errBuf, sizeof(errBuf), "err:dlopen failed");
      setStatus(ST_FAILED, errBuf);
      return errBuf;
    }
  }
  dlerror();
  node_start_fn start = (node_start_fn)dlsym(h, "_ZN4node5StartEiPPc");
  const char *e = dlerror();
  if (!start || (e && e[0])) {
    logWrite("[embed] dlsym(node::Start) failed: %s", e ? e : "null sym");
    snprintf(errBuf, sizeof(errBuf), "err:node::Start not found");
    setStatus(ST_FAILED, errBuf);
    return errBuf;
  }
  logWrite("[embed] node::Start resolved at %p", (void *)start);

  /* Neutralize io_uring_setup before node::Start runs any libuv code. */
  if (!dl_iterate_phdr(patchIouringSyscall, NULL))
    logWrite("[embed] io_uring patch: libnode.so not found in loaded objects");

  /* argv must outlive the thread — static storage. V8 flags:
   *  - --no-verify-heap : disables V8 heap verification on startup
   *    (defensive — avoids allocation checks that can fail under the
   *    constrained runtime). Harmless no-op when the heap is healthy.
   *  - --jitless : HarmonyOS NEXT enforces W^X + code-signing and refuses
   *    executable memory, so V8's JIT cannot run; the process crashes when
   *    the first JIT page is requested. --jitless runs the pure interpreter.
   *    It also removes the WebAssembly global, which is why the server code
   *    branches on HAS_WASM (src/runtime-capabilities.js) and falls back to
   *    pure-JS HTTP, image, and tokenization paths. */
  static char arg0[MAX_LINE * 2];
  static char arg1[] = "--no-verify-heap";
  static char arg2[] = "--jitless";
  static char arg3[MAX_LINE * 2];
  snprintf(arg0, sizeof(arg0), "%s", nodePath);
  snprintf(arg3, sizeof(arg3), "%s", cfg.script);
  g_nodeArgs.start = start;
  g_nodeArgs.argv[0] = arg0;
  g_nodeArgs.argv[1] = arg1;
  g_nodeArgs.argv[2] = arg2;
  g_nodeArgs.argv[3] = arg3;
  g_nodeArgs.argv[4] = NULL;

  /* Run node::Start on THIS thread — we are already the detached bootstrap
   * thread with a 32MB stack, so there is no reason to hand off again.
   *
   * node::Start returning is abnormal (the server should run forever); log
   * it and let the thread end. NEVER _exit() here: this is the app's own
   * process. */
  /* No SIGSYS shim: a process-wide SIGSYS handler collides with
   * ArkWeb/Chromium's seccomp-bpf SIGSYS requirement in this same process and
   * the app dies from SIGSYS. io_uring_setup is instead neutralized at the
   * libc syscall() GOT entry (see lukerSyscall), so libuv never issues the
   * seccomp-trapped syscall and its epoll batching ring falls back to plain
   * epoll. */
  g_nodeTid = (pid_t)syscall(__NR_gettid);
  setStatus(ST_RUNNING, "node::Start");
  logWrite("[embed] bootstrap tid=%ld, calling node::Start", (long)g_nodeTid);
  int rc = start(4, g_nodeArgs.argv);
  logWrite("[embed] node::Start returned %d (backend stopped)", rc);
  snprintf(errBuf, sizeof(errBuf), "err:node::Start returned %d", rc);
  setStatus(ST_FAILED, errBuf);
  return errBuf;
}

/* ── NAPI surface ── */

static napi_value StartBackend(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  char params[8192] = "";
  if (argc >= 1) {
    size_t copied = 0;
    napi_get_value_string_utf8(env, args[0], params, sizeof(params), &copied);
  }
  const char *result = startBackendAsync(params);

  napi_value napiResult = NULL;
  napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &napiResult);
  return napiResult;
}

/* Report how the background bootstrap is doing. The ArkTS page polls this
 * while probing the HTTP port:
 *   "idle"            — startBackend() was never called
 *   "launching:<msg>" — bootstrap thread alive, still resolving/dlopen-ing
 *   "running:<msg>"   — node::Start entered (thread is the backend)
 *   "failed:<msg>"    — hard failure, the backend will NEVER answer
 */
static napi_value GetBackendStatus(napi_env env, napi_callback_info info) {
  (void)info;
  int code = getStatusCode();
  char out[192];
  switch (code) {
    case ST_RUNNING:
      snprintf(out, sizeof(out), "running:%s", g_statusDetail);
      break;
    case ST_FAILED:
      snprintf(out, sizeof(out), "failed:%s", g_statusDetail);
      break;
    case ST_LAUNCHING:
      snprintf(out, sizeof(out), "launching:%s", g_statusDetail);
      break;
    default:
      snprintf(out, sizeof(out), "idle");
      break;
  }
  napi_value napiResult = NULL;
  napi_create_string_utf8(env, out, NAPI_AUTO_LENGTH, &napiResult);
  return napiResult;
}

static napi_value KillNode(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t pid = -1;
  if (argc >= 1) {
    napi_get_value_int32(env, args[0], &pid);
  }
  int32_t result = -1;
  if (pid > 1) {
    /* TERM first so express can close listening sockets cleanly; KILL if it
     * survives. */
    result = kill((pid_t)pid, SIGTERM);
    if (result == 0) {
      usleep(200 * 1000); /* 200ms grace */
      kill((pid_t)pid, SIGKILL);
    }
  }
  napi_value napiResult = NULL;
  napi_create_int32(env, result, &napiResult);
  return napiResult;
}

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"killNode", NULL, KillNode, NULL, NULL, NULL, napi_default, NULL},
      {"startBackend", NULL, StartBackend, NULL, NULL, NULL, napi_default, NULL},
      {"getBackendStatus", NULL, GetBackendStatus, NULL, NULL, NULL, napi_default, NULL}};
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}
EXTERN_C_END

static napi_module demoModule = {
    1, 0, NULL, Init, "node_ctl", NULL, {0}};

__attribute__((constructor)) void RegisterModule(void) {
  napi_module_register(&demoModule);
}
