# Kernel Modules

> **Superseded.** The v1.5 kernel-module split (phases A–C, 2026-08-15)
> moved files out of `Transform.js`. v1.6 moved **ownership**. The living
> spec, the journey, the dead ends, and the “do not reinvent” table are
> all in **[KernelContract.md](./KernelContract.md)**.
>
> This filename is kept so old links do not 404. The v1.5 snapshot that
> used to live here is git history — do not treat anything in that
> commit as as-built. In particular it is **wrong** about:
> `claimKernels`, `lutKernelTable` as the dispatcher, loops living on
> `Transform.prototype`, `resolveRuns` / `_runBig`, `transformArrayFn`,
> “single-colour never touches a kernel”, and “kernels are LUT-only”.

**jsColorEngine docs:**
[← Deepdive index](./README.md) ·
[The kernel contract](./KernelContract.md)
