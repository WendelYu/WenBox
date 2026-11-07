#import <Cocoa/Cocoa.h>
#include <Carbon/Carbon.h>
#include <pthread.h>
#include <unistd.h>
#include <stdatomic.h>

static _Atomic int stop = 0;
static void *worker(void *arg) {
    while (!stop) {
        CFStringRef keys[] = {kTISPropertyInputSourceCategory};
        CFStringRef values[] = {kTISCategoryKeyboardInputSource};
        CFDictionaryRef dict = CFDictionaryCreate(NULL,(const void**)keys,(const void**)values,1,NULL,NULL);
        CFArrayRef arr = TISCreateInputSourceList(dict, false);
        if (arr) {
            CFIndex n = CFArrayGetCount(arr);
            for (CFIndex j = 0; j < n; j++) {
                TISInputSourceRef s = (TISInputSourceRef)CFArrayGetValueAtIndex(arr,j);
                TISGetInputSourceProperty(s, kTISPropertyInputSourceID);
                TISGetInputSourceProperty(s, kTISPropertyUnicodeKeyLayoutData);
            }
            CFRelease(arr);
        }
        CFRelease(dict);
        TISInputSourceRef cur = TISCopyCurrentKeyboardLayoutInputSource();
        if (cur) { TISGetInputSourceProperty(cur, kTISPropertyInputSourceID); CFRelease(cur); }
        usleep(1000);
    }
    return NULL;
}
int main(void) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Main"];
    for (int i=0;i<40;i++) {
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:[NSString stringWithFormat:@"Item %d",i] action:NULL keyEquivalent:@"x"];
        item.keyEquivalentModifierMask = NSEventModifierFlagCommand | (i % 2 ? NSEventModifierFlagOption : 0);
        [menu addItem:item];
    }
    [NSApp setMainMenu:menu];
    pthread_t a,b; pthread_create(&a,NULL,worker,NULL); pthread_create(&b,NULL,worker,NULL);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ stop=1; [NSApp terminate:nil]; });
    [NSApp run];
    pthread_join(a,NULL); pthread_join(b,NULL);
    puts("OK"); return 0;
}
