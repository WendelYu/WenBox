#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* A disposable owner/core pair. No real input devices or user rooms. */
int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    char parent[32];
    snprintf(parent, sizeof(parent), "%d", getpid());
    if (strcmp(argv[2], "standalone") == 0) unsetenv("WENBOX_INPUT_PARENT_PID");
    else setenv("WENBOX_INPUT_PARENT_PID", parent, 1);
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) {
        if (strcmp(argv[2], "delayed") == 0) usleep(750000);
        if (!dlopen(argv[1], RTLD_NOW)) { fprintf(stderr, "%s\n", dlerror()); return 4; }
        puts("READY"); fflush(stdout);
        for (;;) pause();
    }
    printf("CHILD %d\n", child); fflush(stdout);
    for (;;) pause();
}
