/*
 * bench/lcms_c/bench_lcms.c
 * ==========================
 *
 * Native lcms2 counterpart to bench/lcms-comparison/bench.js.
 *
 * Same methodology as the JS bench — identical workflows, identical
 * pixel count, identical seeded PRNG input, identical timing loop
 * (warmup + median-of-5 batches of BATCH_ITERS calls) — so the two
 * MPx/s numbers can be compared directly.
 *
 *   1. RGB  -> Lab    (sRGB    -> LabD50)   — virtual profiles
 *   2. RGB  -> CMYK   (sRGB    -> GRACoL)
 *   3. CMYK -> RGB    (GRACoL  -> sRGB)
 *   4. CMYK -> CMYK   (GRACoL  -> GRACoL)
 *
 * For each workflow we time two lcms2 variants against the SAME pinned
 * in/out byte buffers:
 *
 *   - flags = 0              : lcms2 auto-decides whether to build a
 *                              device-link precalc LUT (its default).
 *   - HIGHRESPRECALC (0x0400): forces a large-grid precalc LUT for
 *                              every transform — matches jsColorEngine's
 *                              "pre-baked LUT" design.
 *
 * (lcms-wasm has the same two knobs and we report both in bench.js.)
 *
 * Build:  make            (from bench/lcms_c/; compiles lcms2 sources
 *                          directly into the binary, no system lib)
 * Run:    ./bench_lcms    (prints headers + MPx/s table + markdown)
 *
 * Profile path defaults to ../../__tests__/GRACoL2006_Coated1v2.icc
 * relative to the binary, or pass one as argv[1].
 *
 * INTENT_RELATIVE_COLORIMETRIC throughout. TYPE_*_8 everywhere
 * (matches jsColorEngine dataFormat:'int8' for apples-to-apples
 * against the JS bench).
 */

/* Expose clock_gettime / CLOCK_MONOTONIC / struct timespec under
 * strict -std=c99. Without this, glibc's <time.h> hides the POSIX
 * timer API because c99 alone doesn't request it. Must be defined
 * BEFORE any system header is included. */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>

#include "lcms2.h"

/* -------- configuration (mirrors bench/lcms-comparison/bench.js) ------- */

#define PIXEL_COUNT     65536
#define TIMED_BATCHES       5
#define BATCH_ITERS       100
#define WARMUP_ITERS      300

#define DEFAULT_PROFILE_PATH "../../__tests__/GRACoL2006_Coated1v2.icc"

/* -------- helpers ------------------------------------------------------ */

/* Monotonic wall clock in nanoseconds. CLOCK_MONOTONIC on POSIX;
 * QueryPerformanceCounter via clock_gettime shim on MinGW-w64 (gcc).
 */
static uint64_t now_ns(void){
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

/* Seeded PRNG — identical bytes to the JS bench.
 * JS: seed = (seed * 1103515245 + 12345) & 0x7fffffff; arr[i] = seed & 0xff
 * Match in C using uint32_t. */
static void build_input(uint8_t* buf, size_t len){
    uint32_t seed = 0x13579bdfU;
    for(size_t i = 0; i < len; i++){
        seed = (seed * 1103515245U + 12345U) & 0x7fffffffU;
        buf[i] = (uint8_t)(seed & 0xFFU);
    }
}

static int cmp_double(const void* a, const void* b){
    double da = *(const double*)a;
    double db = *(const double*)b;
    return (da > db) - (da < db);
}

/* Time a closure represented by a workflow handle + transform handle.
 * Returns median ms per iteration over TIMED_BATCHES batches.
 * `fn` is the cmsDoTransform call — we inline it here because C has
 * no first-class closures.
 */
static double time_transform(cmsHTRANSFORM xf,
                             const void*   in_ptr,
                             void*         out_ptr,
                             cmsUInt32Number pixels){
    /* warmup */
    for(int w = 0; w < WARMUP_ITERS; w++){
        cmsDoTransform(xf, in_ptr, out_ptr, pixels);
    }
    double samples[TIMED_BATCHES];
    for(int r = 0; r < TIMED_BATCHES; r++){
        uint64_t t0 = now_ns();
        for(int i = 0; i < BATCH_ITERS; i++){
            cmsDoTransform(xf, in_ptr, out_ptr, pixels);
        }
        uint64_t t1 = now_ns();
        samples[r] = (double)(t1 - t0) / 1.0e6 / (double)BATCH_ITERS;
    }
    qsort(samples, TIMED_BATCHES, sizeof(double), cmp_double);
    return samples[TIMED_BATCHES / 2];
}

static double mpx_per_sec(double ms_per_iter){
    return ((double)PIXEL_COUNT / 1.0e6) / (ms_per_iter / 1000.0);
}

/* -------- workflow table ---------------------------------------------- */

typedef struct {
    const char*     name;
    int             in_ch;
    int             out_ch;
    cmsUInt32Number in_type;
    cmsUInt32Number out_type;
    int             src_is_gracol;   /* 0 = sRGB, 1 = GRACoL */
    int             dst_is_gracol;   /* 0 = sRGB/Lab, 1 = GRACoL */
    int             dst_is_lab;      /* only meaningful when !dst_is_gracol */
} workflow_t;

static const workflow_t WORKFLOWS[] = {
    { "RGB  -> Lab    (sRGB    -> LabD50) ", 3, 3, TYPE_RGB_8,  TYPE_Lab_8,  0, 0, 1 },
    { "RGB  -> CMYK   (sRGB    -> GRACoL) ", 3, 4, TYPE_RGB_8,  TYPE_CMYK_8, 0, 1, 0 },
    { "CMYK -> RGB    (GRACoL  -> sRGB)   ", 4, 3, TYPE_CMYK_8, TYPE_RGB_8,  1, 0, 0 },
    { "CMYK -> CMYK   (GRACoL  -> GRACoL) ", 4, 4, TYPE_CMYK_8, TYPE_CMYK_8, 1, 1, 0 },
};
#define N_WORKFLOWS (sizeof(WORKFLOWS) / sizeof(WORKFLOWS[0]))

/* -------- per-workflow result ----------------------------------------- */

typedef struct {
    const char* name;
    double      mpx_default;
    double      mpx_highres;
    double      ms_default;
    double      ms_highres;
    int         max_diff;      /* default vs highres, first 1024 bytes */
} result_t;

/* -------- main --------------------------------------------------------- */

int main(int argc, char** argv){
    const char* profile_path = (argc > 1) ? argv[1] : DEFAULT_PROFILE_PATH;

    /* ---- load profiles -------------------------------------------- */

    cmsHPROFILE hGRACoL = cmsOpenProfileFromFile(profile_path, "r");
    if(!hGRACoL){
        fprintf(stderr, "ERROR: failed to open profile: %s\n", profile_path);
        fprintf(stderr, "       (pass the .icc path as argv[1] if running from elsewhere)\n");
        return 2;
    }
    cmsHPROFILE hSRGB = cmsCreate_sRGBProfile();
    cmsHPROFILE hLab  = cmsCreateLab4Profile(NULL);  /* D50 white point */

    if(!hSRGB || !hLab){
        fprintf(stderr, "ERROR: failed to create virtual sRGB / Lab profiles\n");
        return 2;
    }

    /* ---- print banner --------------------------------------------- */

    printf("==============================================================\n");
    printf(" jsColorEngine companion — native lcms2 MPx/s\n");
    printf("==============================================================\n");
    printf(" pixels per iter  : %d\n", PIXEL_COUNT);
    printf(" batches x iters  : %d x %d\n", TIMED_BATCHES, BATCH_ITERS);
    printf(" warmup           : %d iters\n", WARMUP_ITERS);
    printf(" profile          : %s\n", profile_path);
    printf(" lcms2 version    : %d\n", LCMS_VERSION);
    printf(" compiler         :"
#if defined(__clang__)
           " clang %d.%d.%d",
           __clang_major__, __clang_minor__, __clang_patchlevel__
#elif defined(__GNUC__)
           " gcc %d.%d.%d",
           __GNUC__, __GNUC_MINOR__, __GNUC_PATCHLEVEL__
#elif defined(_MSC_VER)
           " MSVC %d", _MSC_VER
#else
           " unknown"
#endif
           );
    printf("\n");
    printf(" arch             :"
#if defined(__x86_64__) || defined(_M_X64)
           " x86_64"
#elif defined(__i386__) || defined(_M_IX86)
           " x86"
#elif defined(__aarch64__) || defined(_M_ARM64)
           " aarch64"
#else
           " unknown"
#endif
    );
    printf("\n");
    fflush(stdout);

    /* ---- run each workflow ---------------------------------------- */

    result_t results[N_WORKFLOWS];

    for(size_t w = 0; w < N_WORKFLOWS; w++){
        const workflow_t* wf = &WORKFLOWS[w];

        printf("\n--------------------------------------------------------------\n");
        printf(" %s\n", wf->name);
        printf("--------------------------------------------------------------\n");
        fflush(stdout);

        cmsHPROFILE hIn  = wf->src_is_gracol ? hGRACoL : hSRGB;
        cmsHPROFILE hOut = wf->dst_is_gracol ? hGRACoL
                         : wf->dst_is_lab     ? hLab
                         :                      hSRGB;

        size_t in_bytes  = (size_t)PIXEL_COUNT * (size_t)wf->in_ch;
        size_t out_bytes = (size_t)PIXEL_COUNT * (size_t)wf->out_ch;

        uint8_t* in_buf  = (uint8_t*)malloc(in_bytes);
        uint8_t* out_buf = (uint8_t*)malloc(out_bytes);
        uint8_t* out_hi  = (uint8_t*)malloc(out_bytes);
        if(!in_buf || !out_buf || !out_hi){
            fprintf(stderr, "ERROR: malloc failed\n");
            return 2;
        }
        build_input(in_buf, in_bytes);

        /* ---- default flags (0) ----------------------------------- */
        cmsHTRANSFORM xfDef = cmsCreateTransform(
            hIn,  wf->in_type,
            hOut, wf->out_type,
            INTENT_RELATIVE_COLORIMETRIC, 0);
        if(!xfDef){
            fprintf(stderr, "ERROR: cmsCreateTransform failed (flags=0)\n");
            return 2;
        }
        double ms_def = time_transform(xfDef, in_buf, out_buf, PIXEL_COUNT);
        cmsDeleteTransform(xfDef);

        /* ---- HIGHRESPRECALC -------------------------------------- */
        cmsHTRANSFORM xfHi = cmsCreateTransform(
            hIn,  wf->in_type,
            hOut, wf->out_type,
            INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_HIGHRESPRECALC);
        if(!xfHi){
            fprintf(stderr, "ERROR: cmsCreateTransform failed (flags=HIGHRESPRECALC)\n");
            return 2;
        }
        double ms_hi = time_transform(xfHi, in_buf, out_hi, PIXEL_COUNT);
        cmsDeleteTransform(xfHi);

        /* default vs highres sanity: max abs LSB diff in first 1024 bytes */
        int max_diff = 0;
        size_t check_n = out_bytes < 1024 ? out_bytes : 1024;
        for(size_t i = 0; i < check_n; i++){
            int d = (int)out_buf[i] - (int)out_hi[i];
            if(d < 0) d = -d;
            if(d > max_diff) max_diff = d;
        }

        double mpx_def = mpx_per_sec(ms_def);
        double mpx_hi  = mpx_per_sec(ms_hi);

        printf("  flags = 0                    : %7.1f MPx/s   (%.2f ms/iter)\n", mpx_def, ms_def);
        printf("  HIGHRESPRECALC               : %7.1f MPx/s   (%.2f ms/iter)   (default vs highres max diff: %d LSB)\n", mpx_hi, ms_hi, max_diff);

        results[w].name         = wf->name;
        results[w].mpx_default  = mpx_def;
        results[w].mpx_highres  = mpx_hi;
        results[w].ms_default   = ms_def;
        results[w].ms_highres   = ms_hi;
        results[w].max_diff     = max_diff;

        free(in_buf);
        free(out_buf);
        free(out_hi);
    }

    /* ---- summary table -------------------------------------------- */

    printf("\n==============================================================\n");
    printf(" SUMMARY — Mpx/s (higher is better)\n");
    printf("==============================================================\n");
    printf("  workflow                          lcms-def  lcms-hi \n");
    printf("  --------------------------------  --------  --------\n");
    for(size_t w = 0; w < N_WORKFLOWS; w++){
        printf("  %-32s  %6.1f M  %6.1f M\n",
               results[w].name,
               results[w].mpx_default,
               results[w].mpx_highres);
    }

    /* ---- markdown for copy-paste into docs ------------------------ */

    printf("\nMarkdown:\n");
    printf("| Workflow | lcms2 native default | lcms2 native HIGHRESPRECALC |\n");
    printf("|---|---|---|\n");
    for(size_t w = 0; w < N_WORKFLOWS; w++){
        /* trim trailing spaces from name for markdown */
        char trim[64];
        strncpy(trim, results[w].name, sizeof(trim) - 1);
        trim[sizeof(trim) - 1] = '\0';
        for(int i = (int)strlen(trim) - 1; i >= 0 && trim[i] == ' '; i--){
            trim[i] = '\0';
        }
        printf("| %s | %.1f MPx/s | %.1f MPx/s |\n",
               trim,
               results[w].mpx_default,
               results[w].mpx_highres);
    }

    /* ---- cleanup -------------------------------------------------- */

    cmsCloseProfile(hGRACoL);
    cmsCloseProfile(hSRGB);
    cmsCloseProfile(hLab);

    return 0;
}
