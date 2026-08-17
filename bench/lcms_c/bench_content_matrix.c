/*
 * bench/lcms_c/bench_content_matrix.c
 * ===================================
 *
 * Release-grade sweep of native lcms2 across the three axes that actually
 * move the numbers, so a comparison table can state its conditions instead
 * of quoting one figure:
 *
 *   CONTENT   noise / gradient / blocks16 / solid
 *   CACHE     flags = 0  vs  cmsFLAGS_NOCACHE
 *   SIZE      pixels per iteration (L1-resident through to memory-bound)
 *
 * WHY EACH AXIS EXISTS
 * --------------------
 * Content: lcms memoises the previous pixel inside cmsDoTransform. How often
 *   that hits is a property of the image, not the library. `blocks16` is Marti
 *   Maria's generator (16x16 flat colour blocks, ~93.8% of pixels equal to the
 *   previous one); `noise` is the original per-pixel PRNG (0%). Reporting one
 *   without the other is how a 3x "speedup" appears from nowhere.
 *
 * Cache: running the same content with cmsFLAGS_NOCACHE separates "the
 *   transform is faster" from "the cache is hitting". It also exposes what the
 *   cache costs when it never hits — a real tax on noisy content.
 *
 * Size: 16K px is L1/L2 resident; 10M px streams from memory. A library can
 *   look faster purely by being measured on a buffer that fits in cache.
 *
 * Iteration counts auto-scale to keep each timed batch near TARGET_BATCH_MS,
 * so small buffers are not measured with too few samples and large ones do not
 * take all day.
 *
 * Build (from bench/lcms_c/):
 *   gcc -O3 -std=c99 -I lcms2-2.18/include -o bench_content_matrix \
 *       bench_content_matrix.c lcms2-2.18/src/*.c -lm
 *
 * NOTE ON COMPILE FLAGS: -march=native measured *slower* than plain -O3 on at
 * least one machine (Ryzen 7700X, ~20-30% on the RGB workflows). Sweep flags
 * with flag_sweep.sh and state the winning set alongside any published table —
 * a comparison should give lcms its best build, not ours.
 *
 * Run:
 *   ./bench_content_matrix                       (default sizes)
 *   ./bench_content_matrix --sizes 16384,65536,1048576,10485760
 *   ./bench_content_matrix --profile path.icc
 */

#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>
#include "lcms2.h"

#define TIMED_BATCHES     5
#define TARGET_BATCH_MS   400.0
#define MIN_ITERS         3
#define MAX_ITERS         2000
#define DEFAULT_PROFILE   "../../__tests__/GRACoL2006_Coated1v2.icc"
#define MAX_SIZES         8

static uint64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

/* ---------------- content generators ---------------------------------- */

typedef enum { C_NOISE = 0, C_GRADIENT, C_BLOCKS16, C_SOLID, C_COUNT } content_t;
static const char *CONTENT_NAME[C_COUNT] = { "noise", "gradient", "blocks16", "solid" };

/* Every pixel unique: the memo cache never hits. */
static void gen_noise(uint8_t *buf, size_t len) {
    uint32_t seed = 0x13579bdfU;
    for (size_t i = 0; i < len; i++) {
        seed = (seed * 1103515245U + 12345U) & 0x7fffffffU;
        buf[i] = (uint8_t)(seed & 0xFFU);
    }
}

/* Smooth ramps quantised to 4-8 px flat runs — photo-like repetition. */
static void gen_gradient(uint8_t *buf, size_t npx, int channels) {
    const int width = 1024;
    for (size_t p = 0; p < npx; p++) {
        int x = (int)(p % (size_t)width), y = (int)(p / (size_t)width);
        for (int c = 0; c < channels; c++)
            buf[p * (size_t)channels + (size_t)c] = (uint8_t)(((x >> 2) + (y >> 3) + c * 40) & 0xFF);
    }
}

/* Marti Maria's generator: 16x16 flat colour blocks. ~93.8% adjacency. */
static void gen_blocks16(uint8_t *buf, size_t npx, int channels) {
    const int width = 1024, bw = 16, bh = 16;
    int height = (int)((npx + (size_t)width - 1) / (size_t)width);
    uint32_t seed = 0x13579bdfU;
    for (int y = 0; y < height; y += bh) {
        for (int x = 0; x < width; x += bw) {
            uint8_t color[4];
            for (int c = 0; c < channels; c++) {
                seed = (seed * 1103515245U + 12345U) & 0x7fffffffU;
                color[c] = (uint8_t)(seed & 0xFFU);
            }
            for (int dy = 0; dy < bh && y + dy < height; dy++)
                for (int dx = 0; dx < bw && x + dx < width; dx++) {
                    size_t p = (size_t)(y + dy) * (size_t)width + (size_t)(x + dx);
                    if (p >= npx) continue;
                    for (int c = 0; c < channels; c++)
                        buf[p * (size_t)channels + (size_t)c] = color[c];
                }
        }
    }
}

/* One colour everywhere: the cache's ceiling. */
static void gen_solid(uint8_t *buf, size_t npx, int channels) {
    uint8_t px[4]; uint32_t seed = 0x13579bdfU;
    for (int c = 0; c < channels; c++) {
        seed = (seed * 1103515245U + 12345U) & 0x7fffffffU;
        px[c] = (uint8_t)(seed & 0xFFU);
    }
    for (size_t p = 0; p < npx; p++)
        for (int c = 0; c < channels; c++)
            buf[p * (size_t)channels + (size_t)c] = px[c];
}

static void build_content(content_t k, uint8_t *buf, size_t npx, int channels) {
    switch (k) {
        case C_NOISE:    gen_noise(buf, npx * (size_t)channels); break;
        case C_GRADIENT: gen_gradient(buf, npx, channels);       break;
        case C_BLOCKS16: gen_blocks16(buf, npx, channels);       break;
        default:         gen_solid(buf, npx, channels);          break;
    }
}

/* Fraction of pixels byte-identical to the previous one — i.e. exactly what
 * lcms's one-pixel cache can hit. Reported so a reader can attribute any
 * speedup to the content rather than guess at it. */
static double adjacency(const uint8_t *buf, size_t npx, int channels) {
    size_t hits = 0;
    for (size_t p = 1; p < npx; p++) {
        int same = 1;
        for (int c = 0; c < channels; c++)
            if (buf[p * (size_t)channels + (size_t)c] !=
                buf[(p - 1) * (size_t)channels + (size_t)c]) { same = 0; break; }
        hits += (size_t)same;
    }
    return npx > 1 ? (double)hits / (double)(npx - 1) : 0.0;
}

/* ---------------- timing ---------------------------------------------- */

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static double time_transform(cmsHTRANSFORM xf, const void *in, void *out,
                             cmsUInt32Number w, cmsUInt32Number h,
                             cmsUInt32Number is, cmsUInt32Number os) {
    /* one call to size the batch, then warm up for as long as we will time */
    uint64_t t0 = now_ns();
    cmsDoTransformLineStride(xf, in, out, w, h, is, os, 0, 0);
    double one_ms = (double)(now_ns() - t0) / 1.0e6;
    if (one_ms <= 0.0) one_ms = 0.001;

    int iters = (int)(TARGET_BATCH_MS / one_ms);
    if (iters < MIN_ITERS) iters = MIN_ITERS;
    if (iters > MAX_ITERS) iters = MAX_ITERS;

    for (int i = 0; i < iters; i++)
        cmsDoTransformLineStride(xf, in, out, w, h, is, os, 0, 0);

    double s[TIMED_BATCHES];
    for (int r = 0; r < TIMED_BATCHES; r++) {
        uint64_t a = now_ns();
        for (int i = 0; i < iters; i++)
            cmsDoTransformLineStride(xf, in, out, w, h, is, os, 0, 0);
        s[r] = (double)(now_ns() - a) / 1.0e6 / (double)iters;
    }
    qsort(s, TIMED_BATCHES, sizeof(double), cmp_double);
    return s[TIMED_BATCHES / 2];
}

/* ---------------- workflows ------------------------------------------- */

typedef struct {
    const char *name; int in_ch, out_ch;
    cmsUInt32Number in_type, out_type;
    int src_gracol, dst_gracol, dst_lab;
} workflow_t;

static const workflow_t WORKFLOWS[] = {
    { "RGB  -> Lab ", 3, 3, TYPE_RGB_8,  TYPE_Lab_8,  0, 0, 1 },
    { "RGB  -> CMYK", 3, 4, TYPE_RGB_8,  TYPE_CMYK_8, 0, 1, 0 },
    { "CMYK -> RGB ", 4, 3, TYPE_CMYK_8, TYPE_RGB_8,  1, 0, 0 },
    { "CMYK -> CMYK", 4, 4, TYPE_CMYK_8, TYPE_CMYK_8, 1, 1, 0 },
};
#define N_WORKFLOWS (sizeof(WORKFLOWS) / sizeof(WORKFLOWS[0]))

int main(int argc, char **argv) {
    const char *profile_path = DEFAULT_PROFILE;
    size_t sizes[MAX_SIZES] = { 16384, 65536, 1048576, 10485760 };
    int n_sizes = 4;

    /* content filter — bit per content_t, all on by default. Lets a compiler
     * flag sweep run only `noise` (the purest measure of transform throughput,
     * with no cache hits to confound it) instead of the whole matrix. */
    int content_mask = (1 << C_COUNT) - 1;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--profile") && i + 1 < argc) profile_path = argv[++i];
        else if (!strcmp(argv[i], "--sizes") && i + 1 < argc) {
            n_sizes = 0;
            char *tok = strtok(argv[++i], ",");
            while (tok && n_sizes < MAX_SIZES) { sizes[n_sizes++] = (size_t)strtoull(tok, NULL, 10); tok = strtok(NULL, ","); }
        }
        else if (!strcmp(argv[i], "--content") && i + 1 < argc) {
            content_mask = 0;
            char *tok = strtok(argv[++i], ",");
            while (tok) {
                for (int k = 0; k < C_COUNT; k++)
                    if (!strcmp(tok, CONTENT_NAME[k])) content_mask |= (1 << k);
                tok = strtok(NULL, ",");
            }
            if (!content_mask) content_mask = (1 << C_COUNT) - 1;
        }
    }

    cmsHPROFILE hGRACoL = cmsOpenProfileFromFile(profile_path, "r");
    if (!hGRACoL) { fprintf(stderr, "ERROR: cannot open %s\n", profile_path); return 2; }
    cmsHPROFILE hSRGB = cmsCreate_sRGBProfile();
    cmsHPROFILE hLab  = cmsCreateLab4Profile(NULL);

    printf("==========================================================================\n");
    printf(" lcms2 %d — content x cache x size sweep (MPx/s, median of %d)\n", LCMS_VERSION, TIMED_BATCHES);
    printf("==========================================================================\n");
    printf(" adjacency = %% of pixels equal to the previous one, i.e. what the\n");
    printf(" one-pixel cache inside cmsDoTransform can hit.\n\n");

    for (size_t w = 0; w < N_WORKFLOWS; w++) {
        const workflow_t *wf = &WORKFLOWS[w];
        cmsHPROFILE hIn  = wf->src_gracol ? hGRACoL : hSRGB;
        cmsHPROFILE hOut = wf->dst_gracol ? hGRACoL : (wf->dst_lab ? hLab : hSRGB);

        printf("\n %s\n", wf->name);
        printf("   content   adj%%        ");
        for (int s = 0; s < n_sizes; s++) printf("%8zuK ", sizes[s] / 1024);
        printf("\n   --------  -----  cache ");
        for (int s = 0; s < n_sizes; s++) printf("--------- ");
        printf("\n");

        for (int k = 0; k < C_COUNT; k++) {
            if (!(content_mask & (1 << k))) continue;
            double adj = -1.0;
            double on[MAX_SIZES], off[MAX_SIZES];

            for (int s = 0; s < n_sizes; s++) {
                size_t npx = sizes[s];
                int width = 1024;
                int height = (int)((npx + (size_t)width - 1) / (size_t)width);
                if (height < 1) height = 1;
                npx = (size_t)width * (size_t)height;

                uint8_t *in  = malloc(npx * (size_t)wf->in_ch);
                uint8_t *out = malloc(npx * (size_t)wf->out_ch);
                if (!in || !out) { fprintf(stderr, "malloc failed\n"); return 2; }
                build_content((content_t)k, in, npx, wf->in_ch);
                if (adj < 0.0) adj = adjacency(in, npx, wf->in_ch) * 100.0;

                cmsUInt32Number flagset[2] = { 0, cmsFLAGS_NOCACHE };
                double r[2];
                for (int f = 0; f < 2; f++) {
                    cmsHTRANSFORM xf = cmsCreateTransform(hIn, wf->in_type, hOut, wf->out_type,
                                                          INTENT_RELATIVE_COLORIMETRIC, flagset[f]);
                    if (!xf) { fprintf(stderr, "cmsCreateTransform failed\n"); return 2; }
                    double ms = time_transform(xf, in, out, (cmsUInt32Number)width, (cmsUInt32Number)height,
                                               (cmsUInt32Number)(width * wf->in_ch),
                                               (cmsUInt32Number)(width * wf->out_ch));
                    r[f] = ((double)npx / 1.0e6) / (ms / 1000.0);
                    cmsDeleteTransform(xf);
                }
                on[s] = r[0]; off[s] = r[1];
                free(in); free(out);
            }

            printf("   %-8s  %5.1f  on    ", CONTENT_NAME[k], adj);
            for (int s = 0; s < n_sizes; s++) printf("%9.1f ", on[s]);
            printf("\n                    off   ");
            for (int s = 0; s < n_sizes; s++) printf("%9.1f ", off[s]);
            printf("\n");
            fflush(stdout);
        }
    }

    printf("\n Read it: where 'on' and 'off' agree, the cache is not engaging and the\n");
    printf(" figure is the transform's real throughput. Where they diverge, the gap\n");
    printf(" is the memo cache reacting to repetition in the input.\n\n");

    cmsCloseProfile(hGRACoL); cmsCloseProfile(hSRGB); cmsCloseProfile(hLab);
    return 0;
}
