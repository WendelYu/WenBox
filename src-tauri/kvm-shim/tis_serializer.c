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
