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
 * For each workflow we time two lcms2 variants, and optionally a
 * third with the fast_float plugin:
 *
 *   - flags = 0              : lcms2 auto-decides whether to build a
 *                              device-link precalc LUT (its default).
 *   - HIGHRESPRECALC (0x0400): forces a large-grid precalc LUT for
 *                              every transform — matches jsColorEngine's
 *                              "pre-baked LUT" design.
 *   - fast_float (optional)  : same two flag variants run inside a
 *                              cmsContext with the fast_float plugin
 *                              installed. Compile with -DWITH_FAST_FLOAT
 *                              (via `make fastfloat`) to enable.
 *
 * Build vanilla:            make
 * Build with fast_float:    make fastfloat
 * Run:                      ./bench_lcms
 *
 * Profile paths default to:
 *   ../../__tests__/GRACoL2006_Coated1v2.icc   (CMYK, argv[1])
 *   ../../samples/profiles/AdobeRGB1998.icc     (RGB,  argv[2])
 *
 * INTENT_RELATIVE_COLORIMETRIC throughout. TYPE_*_8 everywhere
 * (matches jsColorEngine dataFormat:'int8' for apples-to-apples).
 *
 * NOTE: RGB→RGB uses sRGB→AdobeRGB1998 (NOT sRGB→sRGB). lcms2 detects
 * matrix-shaper same-profile transforms as identity and short-circuits
 * cmsDoTransform to memcpy, which would benchmark memcpy speed, not CMS.
 */

/* Expose clock_gettime / CLOCK_MONOTONIC under strict -std=c99. */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>

#include "lcms2.h"

#ifdef WITH_FAST_FLOAT
#include "lcms2_fast_float.h"
#endif

/* -------- configuration (mirrors bench/lcms-comparison/bench.js) ------- */

#define DEFAULT_PIXEL_COUNT  65536
#define TIMED_BATCHES            5
#define DEFAULT_BATCH_ITERS    100
#define DEFAULT_WARMUP_ITERS   300

/* Runtime overrides (see banner):
 *   BENCH_PIXELS=N          pixels per iteration        (default 65536)
 *   BENCH_ITERS=N           iterations per timed batch  (default 100)
 *   BENCH_WARMUP=N          warmup iterations           (default 300)
 *   BENCH_INPUT=gradient    photo-like smooth input with flat runs
 *                           (default: seeded per-byte random noise)
 *
 * Why BENCH_INPUT matters: lcms2 memoizes the last-seen input pixel
 * (one-entry cache inside cmsDoTransform unless cmsFLAGS_NOCACHE).
 * Pure random noise never hits that cache — lcms's worst case; smooth
 * gradient content with runs of repeated pixels approximates real
 * images and lets the cache work. jsColorEngine's kernels are
 * content-independent, so this knob isolates the cache effect.       */
static int g_pixel_count  = DEFAULT_PIXEL_COUNT;
static int g_batch_iters  = DEFAULT_BATCH_ITERS;
static int g_warmup_iters = DEFAULT_WARMUP_ITERS;
static int g_gradient     = 0;
static int g_solid        = 0;   /* BENCH_INPUT=solid: whole image one colour */

#define DEFAULT_CMYK_PROFILE_PATH    "../../__tests__/GRACoL2006_Coated1v2.icc"
#define DEFAULT_ADOBERGB_PROFILE_PATH "../../samples/profiles/AdobeRGB1998.icc"

/* -------- helpers ------------------------------------------------------ */

static uint64_t now_ns(void){
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static void build_input(uint8_t* buf, size_t len, int channels){
    if(g_solid){
        /* Whole image = one seeded-random colour: the 1-px cache's
         * absolute best case (100% hits after the first pixel). */
        uint8_t px[16];
        uint32_t seed = 0x13579bdfU;
        for(int c = 0; c < channels; c++){
            seed = (seed * 1103515245U + 12345U) & 0x7fffffffU;
            px[c] = (uint8_t)(seed & 0xFFU);
        }
        for(size_t i = 0; i < len; i++) buf[i] = px[i % (size_t)channels];
        return;
    }
    if(g_gradient){
        /* Photo-like: smooth 2D gradients quantised to flat 4-8 px runs,
         * so adjacent pixels frequently repeat (exercises lcms's
         * one-pixel cache the way real image content does). */
        size_t npx  = len / (size_t)channels;
        int  width  = 1024;
        for(size_t p = 0; p < npx; p++){
            int x = (int)(p % (size_t)width);
            int y = (int)(p / (size_t)width);
            for(int c = 0; c < channels; c++){
                buf[p * (size_t)channels + (size_t)c] =
                    (uint8_t)(((x >> 2) + (y >> 3) + c * 40) & 0xFF);
            }
        }
        return;
    }
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

static double time_transform(cmsHTRANSFORM xf,
                             const void*   in_ptr,
                             void*         out_ptr,
                             cmsUInt32Number pixels){
    for(int w = 0; w < g_warmup_iters; w++){
        cmsDoTransform(xf, in_ptr, out_ptr, pixels);
    }
    double samples[TIMED_BATCHES];
    for(int r = 0; r < TIMED_BATCHES; r++){
        uint64_t t0 = now_ns();
        for(int i = 0; i < g_batch_iters; i++){
            cmsDoTransform(xf, in_ptr, out_ptr, pixels);
        }
        uint64_t t1 = now_ns();
        samples[r] = (double)(t1 - t0) / 1.0e6 / (double)g_batch_iters;
    }
    qsort(samples, TIMED_BATCHES, sizeof(double), cmp_double);
    return samples[TIMED_BATCHES / 2];
}

static double mpx_per_sec(double ms_per_iter){
    return ((double)g_pixel_count / 1.0e6) / (ms_per_iter / 1000.0);
}

/* -------- workflow table ---------------------------------------------- */

typedef struct {
    const char*     name;
    int             in_ch;
    int             out_ch;
    cmsUInt32Number in_type;
    cmsUInt32Number out_type;
    int             src_is_gracol;    /* 0 = sRGB, 1 = GRACoL */
    int             dst_is_gracol;    /* 0 = sRGB/AdobeRGB, 1 = GRACoL */
    int             dst_is_adobergb;  /* 1 = AdobeRGB1998 output */
    int             is_softproof;     /* 1 = 3-profile sRGB→GRACoL→sRGB, forces a 3D LUT */
} workflow_t;

/* Mirrors the JS bench (bench/mpx_summary.js) plus one extra workflow.
 * RGB->RGB uses sRGB->AdobeRGB1998 (not sRGB->sRGB) to avoid the
 * lcms2 identity-bypass that short-circuits to memcpy.
 * The soft-proof workflow (5) forces a 3D LUT for RGB in/out via a
 * CMYK intermediate — tests the LUT path for RGB->RGB, not matrix. */
static const workflow_t WORKFLOWS[] = {
    { "RGB  -> RGB    (sRGB -> AdobeRGB1998) ",         3, 3, TYPE_RGB_8,  TYPE_RGB_8,  0, 0, 1, 0 },
    { "RGB  -> CMYK   (sRGB -> GRACoL)       ",         3, 4, TYPE_RGB_8,  TYPE_CMYK_8, 0, 1, 0, 0 },
    { "CMYK -> RGB    (GRACoL -> sRGB)        ",         4, 3, TYPE_CMYK_8, TYPE_RGB_8,  1, 0, 0, 0 },
    { "CMYK -> CMYK   (GRACoL -> GRACoL)      ",         4, 4, TYPE_CMYK_8, TYPE_CMYK_8, 1, 1, 0, 0 },
    { "RGB  -> RGB    (sRGB > GRACoL > sRGB, 3D LUT) ", 3, 3, TYPE_RGB_8,  TYPE_RGB_8,  0, 0, 0, 1 },
};
#define N_WORKFLOWS (sizeof(WORKFLOWS) / sizeof(WORKFLOWS[0]))

/* -------- per-workflow result ----------------------------------------- */

typedef struct {
    const char* name;
    /* vanilla lcms2 */
    double      mpx_default;
    double      mpx_highres;
    double      ms_default;
    double      ms_highres;
    int         max_diff;      /* vanilla flags=0 vs HIGHRESPRECALC output diff */
#ifdef WITH_FAST_FLOAT
    /* fast_float plugin */
    double      mpx_ff_default;
    double      mpx_ff_highres;
    double      ms_ff_default;
    double      ms_ff_highres;
    int         max_diff_ff;   /* ff flags=0 vs HIGHRESPRECALC output diff */
    double      speedup_ff;    /* ff_best / vanilla_best */
#endif
} result_t;

static void lcms_error_handler(cmsContext ctx, cmsUInt32Number ec, const char* text){
    (void)ctx;
    fprintf(stderr, "  [lcms2 error %u] %s\n", ec, text);
}

/* -------- main --------------------------------------------------------- */

int main(int argc, char** argv){
    cmsSetLogErrorHandler(lcms_error_handler);

    {
        const char* e;
        if((e = getenv("BENCH_PIXELS")) != NULL && atoi(e) > 0)  g_pixel_count  = atoi(e);
        if((e = getenv("BENCH_ITERS"))  != NULL && atoi(e) > 0)  g_batch_iters  = atoi(e);
        if((e = getenv("BENCH_WARMUP")) != NULL && atoi(e) >= 0) g_warmup_iters = atoi(e);
        if((e = getenv("BENCH_INPUT")) != NULL && strcmp(e, "gradient") == 0) g_gradient = 1;
        if((e = getenv("BENCH_INPUT")) != NULL && strcmp(e, "solid")    == 0) g_solid    = 1;
    }

    const char* cmyk_path     = (argc > 1) ? argv[1] : DEFAULT_CMYK_PROFILE_PATH;
    const char* adobergb_path = (argc > 2) ? argv[2] : DEFAULT_ADOBERGB_PROFILE_PATH;

    /* ---- load vanilla profiles ---------------------------------------- */

    cmsHPROFILE hGRACoL   = cmsOpenProfileFromFile(cmyk_path,     "r");
    cmsHPROFILE hAdobeRGB = cmsOpenProfileFromFile(adobergb_path, "r");
    if(!hGRACoL){
        fprintf(stderr, "ERROR: failed to open CMYK profile: %s\n", cmyk_path);
        fprintf(stderr, "       (pass path as argv[1])\n");
        return 2;
    }
    if(!hAdobeRGB){
        fprintf(stderr, "ERROR: failed to open AdobeRGB profile: %s\n", adobergb_path);
        fprintf(stderr, "       (pass path as argv[2])\n");
        return 2;
    }
    cmsHPROFILE hSRGB = cmsCreate_sRGBProfile();
    if(!hSRGB){
        fprintf(stderr, "ERROR: failed to create virtual sRGB profile\n");
        return 2;
    }

#ifdef WITH_FAST_FLOAT
    /* ---- create fast_float context + profiles inside it --------------- */
    /* Using cmsCreateContext() installs the plugin only in this context,
     * so vanilla transforms (created in the NULL/global context above)
     * are unaffected regardless of run order.                            */
    cmsContext ffCtx = cmsCreateContext(cmsFastFloatExtensions(), NULL);
    if(!ffCtx){
        fprintf(stderr, "ERROR: cmsCreateContext(fast_float) failed\n");
        return 2;
    }
    cmsHPROFILE hGRACoL_ff   = cmsOpenProfileFromFileTHR(ffCtx, cmyk_path,     "r");
    cmsHPROFILE hAdobeRGB_ff = cmsOpenProfileFromFileTHR(ffCtx, adobergb_path, "r");
    cmsHPROFILE hSRGB_ff     = cmsCreate_sRGBProfileTHR(ffCtx);
    if(!hGRACoL_ff || !hAdobeRGB_ff || !hSRGB_ff){
        fprintf(stderr, "ERROR: fast_float profile creation failed\n");
        return 2;
    }
#endif

    /* ---- print banner ------------------------------------------------- */

    printf("==============================================================\n");
    printf(" jsColorEngine companion — native lcms2 MPx/s\n");
#ifdef WITH_FAST_FLOAT
    printf(" ** WITH fast_float plugin (SSE2) **\n");
#endif
    printf("==============================================================\n");
    printf(" pixels per iter  : %d\n", g_pixel_count);
    printf(" batches x iters  : %d x %d\n", TIMED_BATCHES, g_batch_iters);
    printf(" warmup           : %d iters\n", g_warmup_iters);
    printf(" input content    : %s\n",
           g_solid    ? "solid (one colour — lcms 1-px cache best case)" :
           g_gradient ? "gradient (photo-like, flat runs — lcms 1-px cache active)"
                      : "random noise (content-independent worst case)");
    printf(" CMYK profile     : %s\n", cmyk_path);
    printf(" AdobeRGB profile : %s\n", adobergb_path);
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

    /* ---- run each workflow -------------------------------------------- */

    result_t results[N_WORKFLOWS];

    for(size_t w = 0; w < N_WORKFLOWS; w++){
        const workflow_t* wf = &WORKFLOWS[w];

        printf("\n--------------------------------------------------------------\n");
        printf(" %s\n", wf->name);
        printf("--------------------------------------------------------------\n");
        fflush(stdout);

        cmsHPROFILE hIn  = wf->src_is_gracol   ? hGRACoL : hSRGB;
        cmsHPROFILE hOut = wf->dst_is_gracol   ? hGRACoL
                         : wf->dst_is_adobergb  ? hAdobeRGB
                         :                        hSRGB;

        size_t in_bytes  = (size_t)g_pixel_count * (size_t)wf->in_ch;
        size_t out_bytes = (size_t)g_pixel_count * (size_t)wf->out_ch;

        uint8_t* in_buf  = (uint8_t*)malloc(in_bytes);
        uint8_t* out_buf = (uint8_t*)malloc(out_bytes);
        uint8_t* out_hi  = (uint8_t*)malloc(out_bytes);
        if(!in_buf || !out_buf || !out_hi){
            fprintf(stderr, "ERROR: malloc failed\n");
            return 2;
        }
        build_input(in_buf, in_bytes, wf->in_ch);

        /* ---- vanilla flags = 0 ---------------------------------------- */
        cmsHTRANSFORM xfDef, xfHi;
        if(wf->is_softproof){
            /* Soft-proof: sRGB → GRACoL → sRGB (relative colorimetric).
             * cmsCreateProofingTransform builds a 3D device-link LUT
             * (RGB→CMYK→RGB), bypassing the matrix-shaper fast path.
             * Tests LUT performance for RGB input/output. */
            xfDef = cmsCreateProofingTransform(
                hSRGB, wf->in_type,
                hSRGB, wf->out_type,
                hGRACoL,
                INTENT_RELATIVE_COLORIMETRIC,
                INTENT_RELATIVE_COLORIMETRIC,
                cmsFLAGS_SOFTPROOFING);
        } else {
            xfDef = cmsCreateTransform(
                hIn, wf->in_type, hOut, wf->out_type,
                INTENT_RELATIVE_COLORIMETRIC, 0);
        }
        if(!xfDef){
            fprintf(stderr, "ERROR: cmsCreateTransform failed (flags=0)\n");
            return 2;
        }
        double ms_def = time_transform(xfDef, in_buf, out_buf, (cmsUInt32Number)g_pixel_count);
        cmsDeleteTransform(xfDef);

        /* ---- vanilla HIGHRESPRECALC ------------------------------------ */
        if(wf->is_softproof){
            xfHi = cmsCreateProofingTransform(
                hSRGB, wf->in_type,
                hSRGB, wf->out_type,
                hGRACoL,
                INTENT_RELATIVE_COLORIMETRIC,
                INTENT_RELATIVE_COLORIMETRIC,
                cmsFLAGS_SOFTPROOFING | cmsFLAGS_HIGHRESPRECALC);
        } else {
            xfHi = cmsCreateTransform(
                hIn, wf->in_type, hOut, wf->out_type,
                INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_HIGHRESPRECALC);
        }
        if(!xfHi){
            fprintf(stderr, "ERROR: cmsCreateTransform failed (HIGHRESPRECALC)\n");
            return 2;
        }
        double ms_hi = time_transform(xfHi, in_buf, out_hi, (cmsUInt32Number)g_pixel_count);
        cmsDeleteTransform(xfHi);

        /* vanilla default vs highres sanity check */
        int max_diff = 0;
        size_t check_n = out_bytes < 1024 ? out_bytes : 1024;
        for(size_t i = 0; i < check_n; i++){
            int d = (int)out_buf[i] - (int)out_hi[i];
            if(d < 0) d = -d;
            if(d > max_diff) max_diff = d;
        }

        double mpx_def = mpx_per_sec(ms_def);
        double mpx_hi  = mpx_per_sec(ms_hi);
        double vanilla_best = mpx_def > mpx_hi ? mpx_def : mpx_hi;

        printf("  vanilla flags=0          : %7.1f MPx/s   (%.2f ms/iter)\n",
               mpx_def, ms_def);
        printf("  vanilla HIGHRESPRECALC   : %7.1f MPx/s   (%.2f ms/iter)"
               "   (def vs highres max diff: %d LSB)\n",
               mpx_hi, ms_hi, max_diff);

        results[w].name        = wf->name;
        results[w].mpx_default = mpx_def;
        results[w].mpx_highres = mpx_hi;
        results[w].ms_default  = ms_def;
        results[w].ms_highres  = ms_hi;
        results[w].max_diff    = max_diff;

#ifdef WITH_FAST_FLOAT
        /* ---- fast_float flags = 0 ------------------------------------- */
        cmsHPROFILE hIn_ff  = wf->src_is_gracol   ? hGRACoL_ff : hSRGB_ff;
        cmsHPROFILE hOut_ff = wf->dst_is_gracol   ? hGRACoL_ff
                            : wf->dst_is_adobergb  ? hAdobeRGB_ff
                            :                        hSRGB_ff;

        cmsHTRANSFORM xfFFDef, xfFFHi;
        if(wf->is_softproof){
            xfFFDef = cmsCreateProofingTransformTHR(
                ffCtx,
                hSRGB_ff, wf->in_type,
                hSRGB_ff, wf->out_type,
                hGRACoL_ff,
                INTENT_RELATIVE_COLORIMETRIC,
                INTENT_RELATIVE_COLORIMETRIC,
                cmsFLAGS_SOFTPROOFING);
        } else {
            xfFFDef = cmsCreateTransformTHR(
                ffCtx, hIn_ff, wf->in_type, hOut_ff, wf->out_type,
                INTENT_RELATIVE_COLORIMETRIC, 0);
        }
        if(!xfFFDef){
            fprintf(stderr, "ERROR: cmsCreateTransformTHR (ff, flags=0) failed\n");
            return 2;
        }
        double ms_ff_def = time_transform(xfFFDef, in_buf, out_buf, (cmsUInt32Number)g_pixel_count);
        cmsDeleteTransform(xfFFDef);

        /* ---- fast_float HIGHRESPRECALC -------------------------------- */
        if(wf->is_softproof){
            xfFFHi = cmsCreateProofingTransformTHR(
                ffCtx,
                hSRGB_ff, wf->in_type,
                hSRGB_ff, wf->out_type,
                hGRACoL_ff,
                INTENT_RELATIVE_COLORIMETRIC,
                INTENT_RELATIVE_COLORIMETRIC,
                cmsFLAGS_SOFTPROOFING | cmsFLAGS_HIGHRESPRECALC);
        } else {
            xfFFHi = cmsCreateTransformTHR(
                ffCtx, hIn_ff, wf->in_type, hOut_ff, wf->out_type,
                INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_HIGHRESPRECALC);
        }
        if(!xfFFHi){
            fprintf(stderr, "ERROR: cmsCreateTransformTHR (ff, HIGHRESPRECALC) failed\n");
            return 2;
        }
        double ms_ff_hi = time_transform(xfFFHi, in_buf, out_hi, (cmsUInt32Number)g_pixel_count);
        cmsDeleteTransform(xfFFHi);

        /* fast_float default vs highres sanity check */
        int max_diff_ff = 0;
        for(size_t i = 0; i < check_n; i++){
            int d = (int)out_buf[i] - (int)out_hi[i];
            if(d < 0) d = -d;
            if(d > max_diff_ff) max_diff_ff = d;
        }

        double mpx_ff_def = mpx_per_sec(ms_ff_def);
        double mpx_ff_hi  = mpx_per_sec(ms_ff_hi);
        double ff_best    = mpx_ff_def > mpx_ff_hi ? mpx_ff_def : mpx_ff_hi;
        double speedup    = ff_best / vanilla_best;

        printf("  fast_float flags=0       : %7.1f MPx/s   (%.2f ms/iter)"
               "   (%.2fx over vanilla)\n",
               mpx_ff_def, ms_ff_def, mpx_ff_def / vanilla_best);
        printf("  fast_float HIGHRESPRECALC: %7.1f MPx/s   (%.2f ms/iter)"
               "   (%.2fx over vanilla)   (def vs highres max diff: %d LSB)\n",
               mpx_ff_hi, ms_ff_hi, mpx_ff_hi / vanilla_best, max_diff_ff);

        results[w].mpx_ff_default = mpx_ff_def;
        results[w].mpx_ff_highres = mpx_ff_hi;
        results[w].ms_ff_default  = ms_ff_def;
        results[w].ms_ff_highres  = ms_ff_hi;
        results[w].max_diff_ff    = max_diff_ff;
        results[w].speedup_ff     = speedup;
#endif

        free(in_buf);
        free(out_buf);
        free(out_hi);
    }

    /* ---- summary table ------------------------------------------------ */

    printf("\n==============================================================\n");
    printf(" SUMMARY — Mpx/s (higher is better)\n");
    printf("==============================================================\n");

#ifdef WITH_FAST_FLOAT
    printf("  workflow                          van-def  van-hi   ff-def   ff-hi    ff/van\n");
    printf("  --------------------------------  -------  -------  -------  -------  ------\n");
    for(size_t w = 0; w < N_WORKFLOWS; w++){
        printf("  %-32s  %5.1f M  %5.1f M  %5.1f M  %5.1f M  %.2fx\n",
               results[w].name,
               results[w].mpx_default,
               results[w].mpx_highres,
               results[w].mpx_ff_default,
               results[w].mpx_ff_highres,
               results[w].speedup_ff);
    }
#else
    printf("  workflow                          lcms-def  lcms-hi \n");
    printf("  --------------------------------  --------  --------\n");
    for(size_t w = 0; w < N_WORKFLOWS; w++){
        printf("  %-32s  %6.1f M  %6.1f M\n",
               results[w].name,
               results[w].mpx_default,
               results[w].mpx_highres);
    }
#endif

    /* ---- markdown for copy-paste into docs ---------------------------- */

    printf("\nMarkdown:\n");

#ifdef WITH_FAST_FLOAT
    printf("| Workflow | vanilla flags=0 | vanilla HIGHRESPRECALC | fast_float flags=0 | fast_float HIGHRESPRECALC | ff/vanilla |\n");
    printf("|---|---|---|---|---|---|\n");
    for(size_t w = 0; w < N_WORKFLOWS; w++){
        char trim[64];
        strncpy(trim, results[w].name, sizeof(trim) - 1);
        trim[sizeof(trim) - 1] = '\0';
        for(int i = (int)strlen(trim) - 1; i >= 0 && trim[i] == ' '; i--){
            trim[i] = '\0';
        }
        printf("| %s | %.1f MPx/s | %.1f MPx/s | %.1f MPx/s | %.1f MPx/s | **%.2fx** |\n",
               trim,
               results[w].mpx_default,
               results[w].mpx_highres,
               results[w].mpx_ff_default,
               results[w].mpx_ff_highres,
               results[w].speedup_ff);
    }
#else
    printf("| Workflow | lcms2 native default | lcms2 native HIGHRESPRECALC |\n");
    printf("|---|---|---|\n");
    for(size_t w = 0; w < N_WORKFLOWS; w++){
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
#endif

    /* ---- cleanup ------------------------------------------------------ */

    cmsCloseProfile(hGRACoL);
    cmsCloseProfile(hAdobeRGB);
    cmsCloseProfile(hSRGB);

#ifdef WITH_FAST_FLOAT
    cmsCloseProfile(hGRACoL_ff);
    cmsCloseProfile(hAdobeRGB_ff);
    cmsCloseProfile(hSRGB_ff);
    cmsDeleteContext(ffCtx);
#endif

    return 0;
}
