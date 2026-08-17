/*
 * bench/lcms_c/bench_content_matrix.c
 * ===================================
 *
 * Isolates CONTENT from lcms2's one-pixel cache.
 *
 * Marti Maria's revision of the throughput harness changed the input from
 * per-pixel PRNG noise to deterministic 16x16 colour blocks and reported "about
 * a x3 boost". Those blocks make 15 of every 16 pixels byte-identical to the
 * previous one on a row-major scan, so the memo cache inside cmsDoTransform
 * hits ~93.8% of the time instead of 0%.
 *
 * This runs the full 2x2 so the two effects cannot be confused:
 *
 *                     cache on (flags = 0)     cache off (cmsFLAGS_NOCACHE)
 *   noise input             A                            B
 *   16x16 blocks            C                            D
 *
 *   C/A  = what the content change buys with the cache available
 *   C/D  = the cache's contribution on block content
 *   B/A  = the cache's contribution on noise (should be ~1.0, nothing to hit)
 *   D    = should land back near A/B if content alone is not the story
 *
 * Everything else is unchanged from bench_lcms.c: same profiles, workflows,
 * timing loop, INTENT_RELATIVE_COLORIMETRIC, TYPE_*_8.
 *
 * Build (from bench/lcms_c/):
 *   gcc -O3 -std=c99 -I lcms2-2.18/include -o bench_content_matrix \
 *       bench_content_matrix.c lcms2-2.18/src/*.c -lm
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

/* Overridable so the buffer-size axis can be separated from the content axis:
 * 256x256 (64K px) is L2-resident, 1024x1024 (1M px) streams from memory. */
#ifndef IMAGE_WIDTH
#define IMAGE_WIDTH     1024
#endif
#ifndef IMAGE_HEIGHT
#define IMAGE_HEIGHT    1024
#endif
#define PIXEL_COUNT     (IMAGE_WIDTH * IMAGE_HEIGHT)
#define TIMED_BATCHES   5
#define BATCH_ITERS     20
#define WARMUP_ITERS    40
#define DEFAULT_PROFILE_PATH "GRACoL2006_Coated1v2.icc"

static uint64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

/* Marti's generator, verbatim: 16x16 flat colour blocks. */
static void build_blocks(uint8_t *buf, int width, int height, int channels) {
    uint32_t seed = 0x13579bdfU;
    const int block_w = 16, block_h = 16;
    for (int y = 0; y < height; y += block_h) {
        for (int x = 0; x < width; x += block_w) {
            uint8_t color[4];
            for (int c = 0; c < channels; c++) {
                seed = (seed * 1103515245U + 12345U) & 0x7fffffffU;
                color[c] = (uint8_t)(seed & 0xFFU);
            }
            for (int dy = 0; dy < block_h && y + dy < height; dy++)
                for (int dx = 0; dx < block_w && x + dx < width; dx++) {
                    size_t p = ((size_t)(y + dy) * (size_t)width + (size_t)(x + dx)) * (size_t)channels;
                    for (int c = 0; c < channels; c++) buf[p + (size_t)c] = color[c];
                }
        }
    }
}

/* The original: per-pixel PRNG noise, every pixel unique. */
static void build_noise(uint8_t *buf, size_t len) {
    uint32_t seed = 0x13579bdfU;
    for (size_t i = 0; i < len; i++) {
        seed = (seed * 1103515245U + 12345U) & 0x7fffffffU;
        buf[i] = (uint8_t)(seed & 0xFFU);
    }
}

static int cmp_double(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static double time_transform(cmsHTRANSFORM xf, const void *in, void *out,
                             cmsUInt32Number w, cmsUInt32Number h,
                             cmsUInt32Number is, cmsUInt32Number os) {
    for (int i = 0; i < WARMUP_ITERS; i++)
        cmsDoTransformLineStride(xf, in, out, w, h, is, os, 0, 0);
    double s[TIMED_BATCHES];
    for (int r = 0; r < TIMED_BATCHES; r++) {
        uint64_t t0 = now_ns();
        for (int i = 0; i < BATCH_ITERS; i++)
            cmsDoTransformLineStride(xf, in, out, w, h, is, os, 0, 0);
        uint64_t t1 = now_ns();
        s[r] = (double)(t1 - t0) / 1.0e6 / (double)BATCH_ITERS;
    }
    qsort(s, TIMED_BATCHES, sizeof(double), cmp_double);
    return s[TIMED_BATCHES / 2];
}

static double mpx(double ms) { return ((double)PIXEL_COUNT / 1.0e6) / (ms / 1000.0); }

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
    const char *profile_path = (argc > 1) ? argv[1] : DEFAULT_PROFILE_PATH;
    cmsHPROFILE hGRACoL = cmsOpenProfileFromFile(profile_path, "r");
    if (!hGRACoL) { fprintf(stderr, "ERROR: cannot open %s\n", profile_path); return 2; }
    cmsHPROFILE hSRGB = cmsCreate_sRGBProfile();
    cmsHPROFILE hLab  = cmsCreateLab4Profile(NULL);

    printf("======================================================================\n");
    printf(" Content vs one-pixel cache — lcms2 %d, %d px/iter, median of %d\n",
           LCMS_VERSION, PIXEL_COUNT, TIMED_BATCHES);
    printf("======================================================================\n");
    printf("  16x16 blocks = Marti's input (~93.8%% of pixels equal the previous one)\n");
    printf("  noise        = original input (0%% repeats)\n\n");
    printf("  workflow       noise/cache  noise/NOcache  blocks/cache  blocks/NOcache\n");
    printf("  -------------  -----------  -------------  ------------  --------------\n");

    for (size_t w = 0; w < N_WORKFLOWS; w++) {
        const workflow_t *wf = &WORKFLOWS[w];
        cmsHPROFILE hIn  = wf->src_gracol ? hGRACoL : hSRGB;
        cmsHPROFILE hOut = wf->dst_gracol ? hGRACoL : (wf->dst_lab ? hLab : hSRGB);

        size_t in_bytes  = (size_t)PIXEL_COUNT * (size_t)wf->in_ch;
        size_t out_bytes = (size_t)PIXEL_COUNT * (size_t)wf->out_ch;
        uint8_t *in_noise  = malloc(in_bytes);
        uint8_t *in_blocks = malloc(in_bytes);
        uint8_t *out_buf   = malloc(out_bytes);
        if (!in_noise || !in_blocks || !out_buf) { fprintf(stderr, "malloc failed\n"); return 2; }

        build_noise(in_noise, in_bytes);
        build_blocks(in_blocks, IMAGE_WIDTH, IMAGE_HEIGHT, wf->in_ch);

        double r[4];
        const uint8_t *inputs[2] = { in_noise, in_blocks };
        cmsUInt32Number flagsets[2] = { 0, cmsFLAGS_NOCACHE };
        int idx = 0;
        for (int content = 0; content < 2; content++) {
            for (int f = 0; f < 2; f++) {
                cmsHTRANSFORM xf = cmsCreateTransform(hIn, wf->in_type, hOut, wf->out_type,
                                                      INTENT_RELATIVE_COLORIMETRIC, flagsets[f]);
                if (!xf) { fprintf(stderr, "cmsCreateTransform failed\n"); return 2; }
                r[idx++] = mpx(time_transform(xf, inputs[content], out_buf,
                                              IMAGE_WIDTH, IMAGE_HEIGHT,
                                              IMAGE_WIDTH * wf->in_ch, IMAGE_WIDTH * wf->out_ch));
                cmsDeleteTransform(xf);
            }
        }

        printf("  %s  %9.1f    %11.1f    %10.1f    %12.1f\n",
               wf->name, r[0], r[1], r[2], r[3]);
        fflush(stdout);

        free(in_noise); free(in_blocks); free(out_buf);
    }

    printf("\n  Read the last two columns: if blocks/NOcache falls back to the noise\n");
    printf("  columns, the gain is the memo cache reacting to content, not the\n");
    printf("  transform running faster.\n\n");

    cmsCloseProfile(hGRACoL); cmsCloseProfile(hSRGB); cmsCloseProfile(hLab);
    return 0;
}
