# bench/lcms_c/Makefile
# ======================
#
# Build the native lcms2 bench binary by compiling lcms2's own sources
# directly into it — no autotools, no meson, no system lcms2 install
# needed. Single `make` from this directory produces ./bench_lcms.
#
# Tested with:
#   - gcc 11+ on Ubuntu 22.04 / WSL2
#   - clang 14+ on Ubuntu / macOS
#   - MinGW-w64 gcc on Windows (MSYS2 or standalone)
#
# Targets:
#   make              — builds ./bench_lcms (release, -O3 -DNDEBUG)
#   make run          — builds, then runs with default profile path
#   make clean        — remove object files + binary
#   make debug        — -O0 -g for gdb
#   make steelman     — max-perf rebuild: -ffast-math -funroll-loops -flto
#                       on top of the release flags. Used to measure
#                       native lcms2's best-case ceiling. Can shift LUT
#                       values by ~1 LSB vs the default release build
#                       due to -ffast-math; ΔE is still well under 1.
#

LCMS_DIR   := lcms2-2.18
LCMS_SRC   := $(LCMS_DIR)/src
LCMS_INC   := $(LCMS_DIR)/include

CC         ?= gcc
CSTD       := -std=c99

# Release defaults — match lcms2's own autotools CFLAGS closely.
# We let the compiler enable all relevant SSE/AVX it thinks is safe
# for the host (-march=native) to measure the best case available on
# the user's CPU, which is what lcms2 shipping binaries typically
# enable via -march=x86-64-v2 / distro packaging.
CFLAGS     ?= -O3 -DNDEBUG -march=native -fno-strict-aliasing
CFLAGS     += $(CSTD) -Wall -Wextra -Wno-unused-parameter \
              -Wno-sign-compare -Wno-unused-but-set-variable \
              -I$(LCMS_INC)

# On POSIX we need -lm for libm.  MinGW-w64 links libm by default
# but the flag is harmless there.
LDFLAGS    ?=
LDLIBS     ?= -lm

# lcms2's own .c sources (all of src/*.c except any bundled plugins
# the benchmark doesn't need).  We pull in everything — no attempt to
# slim the binary; this is a benchmark, not a shipping artefact.
LCMS_SRCS  := $(wildcard $(LCMS_SRC)/*.c)
LCMS_OBJS  := $(LCMS_SRCS:.c=.o)

BENCH_SRC  := bench_lcms.c
BENCH_OBJ  := bench_lcms.o
BIN        := bench_lcms

.PHONY: all run clean debug steelman

all: $(BIN)

$(BIN): $(BENCH_OBJ) $(LCMS_OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS)

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

run: $(BIN)
	./$(BIN)

debug: CFLAGS := -O0 -g $(CSTD) -Wall -Wextra -I$(LCMS_INC) \
                 -Wno-unused-parameter -Wno-sign-compare \
                 -Wno-unused-but-set-variable
debug: clean $(BIN)

# "Steelman" preset — appends the aggressive flags to the release
# defaults so native lcms2 gets every compiler trick short of PGO.
# Target-specific variables in GNU Make propagate to prerequisites,
# so the pattern rule %.o: %.c picks these up automatically.
#
#   -ffast-math     : relax strict IEEE 754 — allow FMA contraction,
#                     reassociation, assume no NaN/Inf, reciprocal
#                     instead of div. Enables more auto-vectorization.
#   -funroll-loops  : aggressive unrolling of the tetrahedral / matrix
#                     inner loops.
#   -flto           : link-time optimization, lets the compiler inline
#                     across lcms2 translation units (cmsGetTransform,
#                     the LUT eval tree, etc.) — normally each .o is
#                     compiled in isolation.
steelman: CFLAGS  += -ffast-math -funroll-loops -flto
steelman: LDFLAGS += -flto
steelman: clean $(BIN)
	@echo ""
	@echo "==> steelman build complete.  Flags: -O3 -march=native -ffast-math -funroll-loops -flto"
	@echo "    Run: ./$(BIN)"

clean:
	rm -f $(BIN) $(BENCH_OBJ) $(LCMS_OBJS)
