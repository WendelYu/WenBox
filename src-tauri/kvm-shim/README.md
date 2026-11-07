# macOS TIS compatibility shim

`tis_serializer.c` is built into `resources/kvm/tis-serializer.dylib` by
`scripts/prepare-kvm-backend.cjs` on macOS.

Deskflow 1.27.0 calls the Text Input Sources (TIS) API from its server and
event threads. On macOS 26 AppKit can call the same API on the main thread;
HIToolbox treats that concurrency as a fatal error and aborts the process.
The shim interposes the TIS entry points used by the core and AppKit and
serialises them with one recursive lock. The upstream input-core binary is
not modified, so its existing permission identity stays valid.

The engine injects the dylib with `DYLD_INSERT_LIBRARIES` only on macOS.
Windows builds do not compile or ship this file.
