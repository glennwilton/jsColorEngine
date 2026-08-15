# samples/

```
samples/
├── ICCImage/                  ICCImage helper module + API reference
│   ├── iccimage.js              immutable image wrapper around jsColorEngine
│   └── ICCImage.md              API reference
│
├── LutBuilder/                LUT creation, TIFF workflow, CLI tool
│   ├── LutBuilder.js            create / edit / serialise LUTs (MIT)
│   ├── lutbuilder.md            practical guide + CLI reference
│   ├── lut-tiff-cli.js          CLI: --create, --import, --validate, --compare, --apply
│   ├── pako.js                  zlib (vendored, browser TIFF export)
│   └── utif.js                  TIFF codec (vendored, browser TIFF import)
│
├── lib/                       shared utilities
│   └── devtools-warn.js         DevTools-open detection + perf banner
│
├── styles/                    shared CSS
│   └── styles.css               dark theme used by all demo pages
│
├── bench/                     interactive browser benchmark (jsCE vs lcms)
├── browser/                   UMD bundle (jsColorEngineWeb.js)
├── images/                    preview images for LUT TIFF builder
├── lcms-wasm-dist/            vendored lcms-wasm (used by vs-lcms + LUT demos)
├── plugins/                   sample engine plugins
├── profiles/                  ICC profiles (GRACoL, ISO Coated, eciCMYK, sRGB)
├── tiff_samples/              output from lut-tiff-cli.js --make-samples
├── video/                     sample clips for live video soft-proof demo
│
├── index.html                 landing page
├── samples.html               demo index
├── softproof.html             soft-proof + CMYK separations
├── softproof-vs-lcms.html     jsCE vs lcms-wasm pixel diff
├── live-video-softproof.html  real-time video soft-proofing
├── lut-cmyk-to-rgb.html       CMYK → RGB via pre-baked LUT
├── lut-tiff-builder.html      generate / import LUT TIFFs
├── colour-calculator.html     ICC-aware Lab/XYZ/RGB/CMYK converter
├── serve.js                   static dev server (node samples/serve.js)
└── LICENSE                    MIT (sample code only; engine is MPL-2.0)
```

## License

All sample code in `samples/` is **MIT** — free to use, copy, and adapt.
The engine itself (`src/`) is MPL-2.0. See [LICENSE](./LICENSE) for details.

ICC profiles in `profiles/` and video clips in `video/` are copyright their
respective owners and are included here for demo purposes only.
Vendored libraries (`pako.js`, `utif.js`, `lcms-wasm-dist/`) retain their
original licenses.

## Running locally

```bash
npm run browser   # build the UMD bundle
npm run serve     # start dev server on :8080
```

Then open <http://localhost:8080/samples/>.
