/*
 * WenBox input-core compatibility shim for macOS 26+.
 *
 * Deskflow 1.27.0 queries the Text Input Sources API from its server/event
 * threads while AppKit's menu-shortcut updater does the same on the main
 * thread.  macOS 26 aborts the process when those APIs are entered from two
 * threads at once:
 *
 *   ABORT -> Text Input Sources or Text Services Manager API is being called
 *   in two threads concurrently.
 *
 * The shim serialises all exported TIS entry points used by the core and by
 * AppKit with one recursive lock.  It is loaded with DYLD_INSERT_LIBRARIES by
 * the WenBox input engine; the upstream binary is not modified, so the
 * permission identity of the installed input component stays stable.
 *
 * This file is built into a universal dylib by scripts/prepare-kvm-backend.cjs.
 * It is intentionally macOS-only and has no effect on other platforms.
 */

#include <Carbon/Carbon.h>
#include <pthread.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* RunEvent::Exit cannot run after a crash or SIGKILL. The input core must
 * never outlive its owning WenBox process and keep capturing input/ports.
 * Only WenBox-launched cores opt in; standalone shim users are unaffected. */
static pid_t g_wenbox_parent;

static void *wenbox_watch_parent(void *unused)
{
    (void)unused;
    for (;;) {
        if (getppid() != g_wenbox_parent) _exit(0);
        usleep(250000);
    }
    return NULL;
}

__attribute__((constructor)) static void wenbox_guard_parent(void)
{
    const char *value = getenv("WENBOX_INPUT_PARENT_PID");
    if (!value) return;
    char *end = NULL;
    errno = 0;
    long parent = strtol(value, &end, 10);
    if (errno || end == value || *end || parent <= 1 || parent > INT_MAX) {
        fputs("WenBox input parent identity is invalid\n", stderr);
        _exit(1);
    }
    g_wenbox_parent = (pid_t)parent;
    // Helpers launched by the core are not direct children of WenBox.
    unsetenv("WENBOX_INPUT_PARENT_PID");
    // Also cover the owner exiting before this library finishes loading.
    if (getppid() != g_wenbox_parent) _exit(0);
    pthread_t watcher;
    if (pthread_create(&watcher, NULL, wenbox_watch_parent, NULL) != 0) {
        fputs("WenBox input parent monitor could not start\n", stderr);
        _exit(1);
    }
    pthread_detach(watcher);
}

static pthread_mutex_t g_tis_serial = PTHREAD_RECURSIVE_MUTEX_INITIALIZER;

CFArrayRef wenbox_TISCreateInputSourceList(CFDictionaryRef properties, Boolean includeAllInstalled)
{
    pthread_mutex_lock(&g_tis_serial);
    CFArrayRef result = TISCreateInputSourceList(properties, includeAllInstalled);
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

void *wenbox_TISGetInputSourceProperty(TISInputSourceRef inputSource, CFStringRef propertyKey)
{
    pthread_mutex_lock(&g_tis_serial);
    void *result = TISGetInputSourceProperty(inputSource, propertyKey);
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

TISInputSourceRef wenbox_TISCopyCurrentKeyboardInputSource(void)
{
    pthread_mutex_lock(&g_tis_serial);
    TISInputSourceRef result = TISCopyCurrentKeyboardInputSource();
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

TISInputSourceRef wenbox_TISCopyCurrentKeyboardLayoutInputSource(void)
{
    pthread_mutex_lock(&g_tis_serial);
    TISInputSourceRef result = TISCopyCurrentKeyboardLayoutInputSource();
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

TISInputSourceRef wenbox_TISCopyCurrentASCIICapableKeyboardInputSource(void)
{
    pthread_mutex_lock(&g_tis_serial);
    TISInputSourceRef result = TISCopyCurrentASCIICapableKeyboardInputSource();
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

TISInputSourceRef wenbox_TISCopyCurrentASCIICapableKeyboardLayoutInputSource(void)
{
    pthread_mutex_lock(&g_tis_serial);
    TISInputSourceRef result = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

TISInputSourceRef wenbox_TISCopyInputSourceForLanguage(CFStringRef language)
{
    pthread_mutex_lock(&g_tis_serial);
    TISInputSourceRef result = TISCopyInputSourceForLanguage(language);
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

OSStatus wenbox_TISSelectInputSource(TISInputSourceRef inputSource)
{
    pthread_mutex_lock(&g_tis_serial);
    OSStatus result = TISSelectInputSource(inputSource);
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

OSStatus wenbox_TISDeselectInputSource(TISInputSourceRef inputSource)
{
    pthread_mutex_lock(&g_tis_serial);
    OSStatus result = TISDeselectInputSource(inputSource);
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

OSStatus wenbox_TISEnableInputSource(TISInputSourceRef inputSource)
{
    pthread_mutex_lock(&g_tis_serial);
    OSStatus result = TISEnableInputSource(inputSource);
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

OSStatus wenbox_TISDisableInputSource(TISInputSourceRef inputSource)
{
    pthread_mutex_lock(&g_tis_serial);
    OSStatus result = TISDisableInputSource(inputSource);
    pthread_mutex_unlock(&g_tis_serial);
    return result;
}

#define WENBOX_INTERPOSE(name) \
    __attribute__((used)) static struct { \
        const void *replacement; \
        const void *replacee; \
    } _wenbox_interpose_##name __attribute__((section("__DATA,__interpose"))) = { \
        (const void *)wenbox_##name, (const void *)name \
    };

WENBOX_INTERPOSE(TISCreateInputSourceList)
WENBOX_INTERPOSE(TISGetInputSourceProperty)
WENBOX_INTERPOSE(TISCopyCurrentKeyboardInputSource)
WENBOX_INTERPOSE(TISCopyCurrentKeyboardLayoutInputSource)
WENBOX_INTERPOSE(TISCopyCurrentASCIICapableKeyboardInputSource)
WENBOX_INTERPOSE(TISCopyCurrentASCIICapableKeyboardLayoutInputSource)
WENBOX_INTERPOSE(TISCopyInputSourceForLanguage)
WENBOX_INTERPOSE(TISSelectInputSource)
WENBOX_INTERPOSE(TISDeselectInputSource)
WENBOX_INTERPOSE(TISEnableInputSource)
WENBOX_INTERPOSE(TISDisableInputSource)
