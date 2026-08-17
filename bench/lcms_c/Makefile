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
#   make              — builds ./bench_lcms (vanilla lcms2, release)
#   make run          — builds, then runs
#   make fastfloat    — builds with fast_float plugin + runs
#   make clean        — remove object files + binary
#   make debug        — -O0 -g for gdb
#   make steelman     — max-perf rebuild: -ffast-math -funroll-loops -flto
#

LCMS_DIR   := lcms2-2.18
LCMS_SRC   := $(LCMS_DIR)/src
LCMS_INC   := $(LCMS_DIR)/include

FF_DIR     := $(LCMS_DIR)/plugins/fast_float
FF_INC     := $(FF_DIR)/include
FF_SRCS    := $(wildcard $(FF_DIR)/src/*.c)
FF_OBJS    := $(patsubst %.c,%.o,$(FF_SRCS))

CC         ?= gcc
CSTD       := -std=c99

# Release defaults — match lcms2's own autotools CFLAGS closely.
# MEASURED 2026-08-18 (Ryzen 7700X, gcc, flag_sweep.sh): -march=native is
# at or near the BOTTOM on every workflow here — the old default below cost
# lcms 15-23%% on the RGB paths versus plain -O2/-O3, which handicapped every
# comparison made with it. No single set wins everything: -O2 takes the RGB
# workflows, -O3 the CMYK ones. Run flag_sweep.sh on YOUR machine before
# publishing anything, and give lcms its best build.
#   old default: -O3 -DNDEBUG -march=native -fno-strict-aliasing
CFLAGS     ?= -O3 -DNDEBUG -fno-strict-aliasing
CFLAGS     += $(CSTD) -Wall -Wextra -Wno-unused-parameter \
              -Wno-sign-compare -Wno-unused-but-set-variable \
              -I$(LCMS_INC)

LDFLAGS    ?=
LDLIBS     ?= -lm

LCMS_SRCS  := $(wildcard $(LCMS_SRC)/*.c)
LCMS_OBJS  := $(LCMS_SRCS:.c=.o)

BENCH_SRC  := bench_lcms.c
BENCH_OBJ  := bench_lcms.o
BIN        := bench_lcms

# When WITH_FF=1 is passed on the command line, add the fast_float
# plugin sources and the -DWITH_FAST_FLOAT flag. The fastfloat target
# below invokes make recursively with WITH_FF=1 after a clean.
ifdef WITH_FF
CFLAGS     += -DWITH_FAST_FLOAT -I$(FF_INC)
EXTRA_OBJS := $(FF_OBJS)
else
EXTRA_OBJS :=
endif

.PHONY: all run fastfloat clean debug steelman

all: $(BIN)

$(BIN): $(BENCH_OBJ) $(LCMS_OBJS) $(EXTRA_OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS)

# Generic rule for lcms2 core sources and bench_lcms.c
%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

# Fast_float plugin sources also need -I$(FF_INC) for their internal header.
# This rule overrides the generic one for paths under $(FF_DIR)/src/.
$(FF_OBJS): %.o: %.c
	$(CC) $(CFLAGS) -I$(FF_INC) -c -o $@ $<

run: $(BIN)
	./$(BIN)

# fastfloat — clean, then rebuild everything with the plugin enabled, then run.
fastfloat:
	$(MAKE) clean
	$(MAKE) WITH_FF=1
	@echo ""
	@echo "==> fast_float build complete."
	./$(BIN)

debug: CFLAGS := -O0 -g $(CSTD) -Wall -Wextra -I$(LCMS_INC) \
                 -Wno-unused-parameter -Wno-sign-compare \
                 -Wno-unused-but-set-variable
debug: clean $(BIN)

# Steelman: aggressive compiler flags on top of release, no fast_float.
steelman: CFLAGS  += -ffast-math -funroll-loops -flto
steelman: LDFLAGS += -flto
steelman: clean $(BIN)
	@echo ""
	@echo "==> steelman build complete.  Flags: -O3 -march=native -ffast-math -funroll-loops -flto"
	@echo "    Run: ./$(BIN)"

clean:
	rm -f $(BIN) $(BENCH_OBJ) $(LCMS_OBJS) $(FF_OBJS)
