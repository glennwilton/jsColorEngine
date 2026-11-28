/**
 * Type definitions for jsColorEngine.
 *
 * Hand-written, and covers the documented public API: Profile, Transform,
 * Loader, the colour helpers (`color` / `convert`), `alpha`, and the enums.
 * The engine is plain JavaScript; nothing here changes how it runs.
 *
 * What is NOT typed: the pipeline stage functions and interpolation loops on
 * Transform (`stage_*`, `createPipeline_*`, `*_loop`), and the kernel module
 * contract. Those are internals, and their shapes are in docs/deepdive.
 *
 * The docs are the reference for behaviour: docs/Transform.md, docs/Profile.md,
 * docs/Loader.md, docs/pool.md.
 */

declare namespace jsColorEngine {

    // ---------------------------------------------------------------------
    // Enums. Plain objects of numbers at runtime.
    // ---------------------------------------------------------------------

    const eIntent: {
        readonly perceptual: 0;
        readonly relative: 1;
        readonly saturation: 2;
        readonly absolute: 3;
    };
    /** A rendering intent: one of the `eIntent` values. */
    type Intent = 0 | 1 | 2 | 3;

    const eColourType: {
        readonly None: 0;
        readonly XYZ: 1;
        readonly Lab: 2;
        readonly LCH: 3;
        readonly Gray: 4;
        readonly RGB: 5;
        readonly CMYK: 6;
        readonly custom: 7;
        readonly RGBf: 8;
        readonly CMYKf: 9;
        readonly Spectrum: 10;
        readonly Greyf: 11;
        readonly Duo: 12;
        readonly Duof: 13;
        readonly xyY: 14;
    };

    const eProfileType: {
        readonly Lab: 0;
        readonly RGBMatrix: 1;
        readonly RGBLut: 2;
        readonly CMYK: 3;
        readonly Gray: 4;
        readonly Duo: 5;
        readonly XYZ: 6;
        /** 5 to 15 colourants. */
        readonly NChannel: 31;
    };
    type ProfileType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 31;

    /** Stage encodings, as seen by a custom pipeline stage. */
    const encoding: {
        readonly device: 0;
        readonly PCSv2: 1;
        readonly PCSv4: 2;
        readonly PCSXYZ: 3;
        readonly LabD50: 3;
        readonly cmsLab: 4;
        readonly cmsRGB: 5;
        readonly cmsCMYK: 6;
        readonly cmsXYZ: 7;
    };
    const encodingStr: string[];

    /** The engine version, from package.json. */
    const version: string;

    // ---------------------------------------------------------------------
    // Colour objects
    // ---------------------------------------------------------------------

    interface WhitePoint {
        desc: string;
        X: number;
        Y: number;
        Z: number;
    }

    /** X, Y, Z in 0..1. */
    interface XYZColor { type: number; X: number; Y: number; Z: number; whitePoint?: WhitePoint; }
    /** L 0..100, a and b about -128..127. */
    interface LabColor { type: number; L: number; a: number; b: number; whitePoint: WhitePoint; }
    /** L 0..100, C 0..100, H 0..360. */
    interface LCHColor { type: number; L: number; C: number; H: number; whitePoint: WhitePoint; }
    /** R, G, B in 0..255. */
    interface RGBColor { type: number; R: number; G: number; B: number; }
    /** Rf, Gf, Bf in 0..1. */
    interface RGBfColor { type: number; Rf: number; Gf: number; Bf: number; }
    /** C, M, Y, K in 0..100. */
    interface CMYKColor { type: number; C: number; M: number; Y: number; K: number; }
    /** Cf, Mf, Yf, Kf in 0..1. */
    interface CMYKfColor { type: number; Cf: number; Mf: number; Yf: number; Kf: number; }
    interface GrayColor { type: number; G: number; }
    interface DuoColor { type: number; a: number; b: number; }
    interface xyYColor { type: number; x: number; y: number; Y: number; }

    /** Any colour object the helpers build and `transform()` accepts or returns. */
    type Color = XYZColor | LabColor | LCHColor | RGBColor | RGBfColor
               | CMYKColor | CMYKfColor | GrayColor | DuoColor | xyYColor;

    /** A 3x3 matrix as the helpers hold it. */
    interface Matrix3x3 {
        m00: number; m01: number; m02: number;
        m10: number; m11: number; m12: number;
        m20: number; m21: number; m22: number;
    }

    /** How Lab is encoded as 16-bit values: `convert.labEncoding.v2` or `.v4`. */
    interface LabEncoding {
        readonly pcsVersion: 2 | 4;
        readonly labNumerator: number;
        readonly lMul: number;
        readonly abMul: number;
        readonly lInvMul: number;
        readonly abInvMul: number;
    }

    /** A colour-difference function, such as `convert.deltaE2000`. */
    type DeltaEFunction = (lab1: LabColor, lab2: LabColor) => number;

    /** An RGB profile, where a helper wants the primaries and gamma. */
    type RGBProfileLike = Profile | { [key: string]: any };

    // ---------------------------------------------------------------------
    // color / convert: colour builders and conversion maths
    // ---------------------------------------------------------------------

    interface ColorHelpers {
        // Builders
        XYZ(X: number, Y: number, Z: number, whitePoint?: WhitePoint): XYZColor;
        Lab(L: number, a: number, b: number, whitePoint?: WhitePoint, rangeCheck?: boolean): LabColor;
        Lch(L: number, c: number, h: number, whitePoint?: WhitePoint): LCHColor;
        LCH(L: number, c: number, h: number, whitePoint?: WhitePoint): LCHColor;
        Gray(g: number, rangeCheck?: boolean): GrayColor;
        Duo(a: number, b: number, rangeCheck?: boolean): DuoColor;
        RGB(r: number, g: number, b: number, rangeCheck?: boolean): RGBColor;
        RGBf(r: number, g: number, b: number): RGBfColor;
        RGBFloat(rf: number, gf: number, bf: number): RGBfColor;
        RGBbyte2Float(r: number, g: number, b: number): RGBfColor;
        CMYK(c: number, m: number, y: number, k: number, rangeCheck?: boolean): CMYKColor;
        CMYKf(c: number, m: number, y: number, k: number): CMYKfColor;
        xyY(x: number, y: number, Y: number): xyYColor;

        // White points
        readonly a: WhitePoint;
        readonly b: WhitePoint;
        readonly c: WhitePoint;
        readonly d50: WhitePoint;
        readonly d55: WhitePoint;
        readonly d65: WhitePoint;
        readonly d75: WhitePoint;
        readonly e: WhitePoint;
        readonly f2: WhitePoint;
        readonly f7: WhitePoint;
        readonly f11: WhitePoint;
        getWhitePoint(whitepointDescription: string): WhitePoint;
        getWhitePointFromIlluminant(illuminant: any): WhitePoint;
        compareWhitePoints(white1: WhitePoint, white2: WhitePoint, tolerance?: number): boolean;

        // Conversions between colour models
        XYZ2xyY(xyz: XYZColor, whitePoint?: WhitePoint): xyYColor;
        xyY2XYZ(xyY: xyYColor): XYZColor;
        XYZ2Lab(xyz: XYZColor, whitePoint?: WhitePoint): LabColor;
        Lab2XYZ(lab: LabColor): XYZColor;
        Lab2LabD50(sourceLab: LabColor): LabColor;
        Lab2Lab(sourceLab: LabColor, destWhitepoint: WhitePoint): LabColor;
        Lab2LCH(lab: LabColor): LCHColor;
        LCH2Lab(lch: LCHColor): LabColor;
        adaptation(xyz: XYZColor, sourceWhite: WhitePoint, destWhite: WhitePoint): XYZColor;

        // RGB through a matrix profile. These are the simple maths, not a
        // Transform: no LUT profiles, no intents.
        RGB2Lab(rgb: RGBColor, rgbProfile: RGBProfileLike, destWhitepoint?: WhitePoint): LabColor;
        RGBf2Lab(rgbf: RGBfColor, rgbProfile: RGBProfileLike, destWhitePoint?: WhitePoint): LabColor;
        RGBf2XYZ(rgbf: RGBfColor, rgbProfile: RGBProfileLike, xyzRefWhite?: WhitePoint): XYZColor;
        RGB2XYZ_bytes(rgb: RGBColor, rgbProfile: RGBProfileLike, xyzRefWhite?: WhitePoint): XYZColor;
        XYZ2RGB_bytes(xyz: XYZColor, xyzRefWhite: WhitePoint, rgbProfile: RGBProfileLike): RGBColor;
        XYZ2RGBf(xyz: XYZColor, xyzRefWhite: WhitePoint, rgbProfile: RGBProfileLike, clip?: boolean): RGBfColor;
        XYZ2RGBDevice(xyz: XYZColor, xyzRefWhite: WhitePoint, rgbProfile: RGBProfileLike, clip?: boolean): number[];
        RGBDevice2XYZ(device: ArrayLike<number>, rgbProfile: RGBProfileLike, xyzRefWhite?: WhitePoint): XYZColor;
        RGBDevice2LabD50(device: ArrayLike<number>, rgbProfile: RGBProfileLike): LabColor;
        Lab2RGB(lab: LabColor, rgbProfile: RGBProfileLike, decimals?: number): RGBColor;
        Lab2RGBf(lab: LabColor, rgbProfile: RGBProfileLike, clip?: boolean): RGBfColor;
        Lab2RGBDevice(lab: LabColor, rgbProfile: RGBProfileLike): number[];
        Lab2sRGB(lab: LabColor): RGBColor;
        RGB2byte(rgbf: RGBfColor): RGBColor;
        RGB2Hex(rgb: RGBColor): string;
        cmsRGB2Hex(rgb: RGBColor): string;
        wavelength2RGB(wavelength: number): RGBColor;

        // Colour difference
        deltaE1976(lab1: LabColor, lab2: LabColor): number;
        deltaE1994(lab1: LabColor, lab2: LabColor, isTextiles?: boolean): number;
        deltaE2000(lab1: LabColor, lab2: LabColor): number;
        deltaECMC(lab1: LabColor, lab2: LabColor, lightnessFactor?: number, chromaFactor?: number): number;

        // Lab as 16-bit values
        readonly labEncoding: { readonly v2: LabEncoding; readonly v4: LabEncoding };
        lab2Int16(L: number, a: number, b: number, encoding: 'v2' | 'v4' | LabEncoding): number[];
        int162Lab(uL: number, ua: number, ub: number, encoding: 'v2' | 'v4' | LabEncoding): LabColor;

        // Tone curves
        gamma(c: number, gamma: number): number;
        gammaInv(c: number, gamma: number): number;
        sRGBGamma(c: number): number;
        sRGBGammaInv(c: number): number;

        // Matrices
        readonly BradfordMtxAdapt: Matrix3x3;
        readonly BradfordMtxAdaptInv: Matrix3x3;
        getBradfordMtxAdapt(): Matrix3x3;
        getBradfordMtxAdaptInv(): Matrix3x3;
        computeMatrix(profile: RGBProfileLike): any;
        invertMatrix(m: Matrix3x3): Matrix3x3;
        matrixScaleValues(matrix: Matrix3x3, scale: number): Matrix3x3;
        matrix2Object(matrixArray: ArrayLike<number>): Matrix3x3;
        objectToMatrix(matrixObject: Matrix3x3): number[];
        multiplyMatrices(matrixA: Matrix3x3, matrixB: Matrix3x3): Matrix3x3;
        multiplyMatricesArray(matrixA: ArrayLike<number>, matrixB: ArrayLike<number>): number[];
        transpose(m: any): any;

        // Text
        intent2String(intent: Intent): string;
        cmsColor2String(color: Color, precision?: number): string;
        whitepoint2String(whitePoint: WhitePoint): string;
    }

    /** Colour builders and conversion maths. */
    const color: ColorHelpers;
    /** The same object as `color`, under its older name. */
    const convert: ColorHelpers;

    // ---------------------------------------------------------------------
    // Profile
    // ---------------------------------------------------------------------

    /** Names of the built-in profiles. Case and the leading `*` are forgiven. */
    type VirtualProfileName =
        | '*sRGB' | '*AdobeRGB' | '*AppleRGB' | '*ColorMatchRGB' | '*ProPhotoRGB'
        | '*Lab' | '*LabD50' | '*LabD65';

    /**
     * Anything `Profile.load()` accepts: the profile bytes, a virtual name
     * (`'*sRGB'`), `'file:...'`, `'http(s)://...'` or `'data:...'` base64.
     */
    type ProfileSource = Uint8Array | ArrayBuffer | VirtualProfileName | (string & {});

    interface ProfileError {
        /** 0 when there is no error. */
        err: number;
        text: string;
    }

    interface ProfileHeader {
        /** Device class: `'mntr'`, `'prtr'`, `'scnr'`, `'link'`, `'abst'`, `'spac'`, `'nmcl'`. */
        pClass?: string;
        /** Device colour space, such as `'RGB'` or `'CMYK'`. */
        space?: string;
        /** `'XYZ'` or `'LAB'`. */
        pcs?: string;
        intent?: number;
        date?: Date;
        /** Such as `'2.1.0'` or `'4.3.0'`. */
        version?: string;
        versionMajor?: number;
        [key: string]: any;
    }

    type ProfileCallback = (profile: Profile) => void;

    /** Options for `Profile.createGrayICC`. Give `gamma` or `samples`. */
    interface CreateGrayICCOptions {
        gamma?: number;
        samples?: ArrayLike<number>;
        description?: string;
        [key: string]: any;
    }

    interface CreateNChannelICCOptions {
        channels: number;
        description?: string;
        [key: string]: any;
    }

    /**
     * An ICC profile, loaded or built in. It holds the profile data and does
     * no conversion: give two of them to a `Transform`.
     *
     * A failed load does not throw. Check `loaded`, and read `lastError`.
     */
    class Profile {
        constructor(dataOrUrl?: ProfileSource, afterLoad?: ProfileCallback);

        /** True once the profile has loaded and is usable. */
        loaded: boolean;
        loadError: boolean;
        lastError: ProfileError;

        /** One of `eProfileType`. A DeviceLink keeps the type of its input space. */
        type: ProfileType;
        name: string;
        header: ProfileHeader;
        /** The profile's own default rendering intent. */
        intent: number;
        description: string;
        copyright: string;
        technology: string;
        /** ICC major version: 2 or 4. Version 3 profiles read as 2. */
        version: number;
        /** `'XYZ'` or `'LAB'`. */
        pcs: string | false;
        colorSpace: string;
        mediaWhitePoint: WhitePoint | null;
        PCSWhitepoint: WhitePoint;
        /** Device channels: 1 Gray, 3 RGB or Lab, 4 CMYK, up to 15 for n-colour. */
        outputChannels: number;
        sizeBytes: number;
        /** The virtual profile's name, such as `'*sRGB'`, or false for a file. */
        virtualName: string | false;
        /** Set by `loadBinary` only. Prefer `profileFingerprint`. */
        binaryHash: string | false;
        /** Byte length and a 64-bit hash of the profile bytes. Set on every load route. */
        profileFingerprint: string | false;
        /**
         * True for an RGB profile with a table in one direction only, where
         * the matrix and curve tags serve the other direction.
         */
        hasMatrixFallback: boolean;
        /** Tag signatures the decoder skipped. */
        unsupportedTags: string[];
        /** @deprecated Use `unsupportedTags`. */
        unsuportedTags: string[];
        virtualProfileUsesD50AdaptedPrimaries: boolean;
        /** @deprecated Use `virtualProfileUsesD50AdaptedPrimaries`. */
        virutalProfileUsesD50AdaptedPrimaries: boolean;
        /** Device to PCS tables by intent: perceptual, relative, saturation. */
        A2B: Array<any | null>;
        /** PCS to device tables by intent: perceptual, relative, saturation. */
        B2A: Array<any | null>;

        /** Load from any supported source. The kind is detected from the value. */
        load(dataOrUrl: ProfileSource, afterLoad?: ProfileCallback): void;
        /** Resolves to this profile when loading ends, whether it worked or not. */
        loadPromise(dataOrUrl: ProfileSource): Promise<Profile>;
        /**
         * Decode profile bytes.
         * @param searchForProfile true when the bytes are a JPEG, TIFF or PNG
         *   file, or other data holding a whole profile: the profile is read
         *   out of it.
         */
        loadBinary(binary: Uint8Array | ArrayBuffer, afterLoad?: ProfileCallback | null, searchForProfile?: boolean): void;
        /** Node and Adobe CEP only. */
        loadFile(filename: string, afterLoad?: ProfileCallback): void;
        loadBase64(base64: string, afterLoad?: ProfileCallback): void;
        loadURL(url: string, afterLoad?: ProfileCallback): void;
        loadVirtualProfile(name: VirtualProfileName | (string & {}), afterLoad?: ProfileCallback): void;

        techSignatureString(signature: string): string;

        /**
         * Write this profile as ICC bytes. Test tooling: it is how the
         * synthetic test profiles are made, and is not supported for building
         * production profiles.
         */
        toICC(options?: { [key: string]: any }): Uint8Array;

        /** Build a gray test profile. Test tooling, as `toICC`. */
        static createGrayICC(options: CreateGrayICCOptions): Uint8Array;
        /** Build an n-channel test profile with both tables. Test tooling. */
        static createNChannelICC(options: CreateNChannelICCOptions): Uint8Array;
        static createNChannelB2AICC(options: CreateNChannelICCOptions): Uint8Array;
        /** The A2B grid size `createNChannelICC` uses for a channel count. */
        static gridFor(channels: number): number;
    }

    // ---------------------------------------------------------------------
    // Loader
    // ---------------------------------------------------------------------

    /** A small registry of profiles by key, with optional preloading. */
    class Loader {
        constructor();
        add(url: ProfileSource, key: string, preload?: boolean): void;
        /** Load every profile added with `preload: true`, in parallel. */
        loadAll(): Promise<any>;
        /** The profile under `key`, loading it first if needed. Check `loaded`. */
        get(key: string): Promise<Profile>;
        findByKey(key: string): Profile | false;
        findByURL(url: string): Profile | false;
    }

    // ---------------------------------------------------------------------
    // Transform
    // ---------------------------------------------------------------------

    type DataFormat = 'object' | 'objectFloat' | 'int8' | 'int16' | 'device';
    type ArrayOutputFormat = 'int8' | 'int16' | 'float32' | 'float64' | 'device';
    type LutMode = 'auto' | 'float' | 'int' | 'int-wasm-scalar' | 'int-wasm-simd'
                 | 'int16-wasm-scalar' | 'int16-wasm-simd' | (string & {});
    type Interpolation = 'tetrahedral' | 'trilinear';
    type GamutMode = 'none' | 'color' | 'colorMap' | 'map';

    /** A profile, or the name of a built-in one. */
    type ProfileOrName = Profile | VirtualProfileName | (string & {});

    /** Arrays `array()` reads from. */
    type PixelInput = ArrayLike<number>;
    /** Arrays `array()` returns: by `dataFormat`, int8, int16, or a plain array. */
    type PixelOutput = Uint8ClampedArray | Uint16Array | Float32Array | Float64Array | number[];

    /**
     * A hook run once per LUT grid cell while the LUT is built. Device values
     * are 0..1. Return an array of the same length.
     */
    type LutInputHook = (device: number[]) => number[];
    /** As `LutInputHook`; `deviceIn` is the grid cell's input, read-only. */
    type LutOutputHook = (deviceOut: number[], deviceIn: ReadonlyArray<number>) => number[];

    /** Runtime information handed to a custom stage function. */
    interface StageInfo {
        inputEncoding: number;
        outputEncoding: number;
        stageName: string;
        stageData: any;
        [key: string]: any;
    }

    /** A function placed in the pipeline, and baked into the LUT if one is built. */
    interface CustomStage {
        description: string;
        /** Where it runs. `'PCS'` is between the two profiles. */
        location: 'PCS' | (string & {});
        stageData?: any;
        stageFn: (input: number[], data: any, stage: StageInfo) => number[];
    }

    interface PoolOptions {
        /** Worker count. `cores` is the same setting under its other name. */
        workers?: number | 'auto' | 'max';
        cores?: number | 'auto' | 'max';
        maxWorkers?: number;
        maxThreads?: number;
        /** Below this many workers, run sequentially. Default 2. */
        minThreads?: number;
        /** 0 keeps idle workers for ever. */
        idleTimeoutMs?: number;
        transformsPerWorker?: number;
        /** Browser only: the URL of `jsColorEngineWorker.js`. */
        workerUrl?: string;
        /** Reconfigure a running pool. */
        restart?: boolean;
        /** With `restart`, drop queued work and do not drain it. */
        cancelQueue?: boolean;
        keepAlive?: boolean;
        debug?: boolean;
        [key: string]: any;
    }

    interface TransformOptions {
        /** Bake the pipeline into a LUT. Needed for the fast image path. */
        buildLut?: boolean;
        /** @deprecated Use `buildLut`. */
        builtLut?: boolean;
        /** Which image kernel to use. Default `'auto'`. */
        lutMode?: LutMode;
        /** The shape of input and output. Default `'object'`. */
        dataFormat?: DataFormat;
        /** Black point compensation: for every stage, or one flag per stage. */
        BPC?: boolean | boolean[];
        /** Round numeric output. Default true. */
        roundOutput?: boolean;
        /** Decimal places when rounding. Default 0. */
        precision?: number;
        /** @deprecated Use `precision`. */
        precession?: number;
        interpolation3D?: Interpolation;
        interpolation4D?: Interpolation;
        LUTinterpolation3D?: Interpolation;
        LUTinterpolation4D?: Interpolation;
        lutGridPoints1D?: number;
        /** Grid points per axis for a 3D LUT. Default 33. */
        lutGridPoints3D?: number;
        /** Grid points per axis for a 4D LUT. Default 17. */
        lutGridPoints4D?: number;
        labAdaptation?: boolean;
        labInputAdaptation?: boolean;
        displayChromaticAdaptation?: boolean;
        /** Record per-stage values. Accuracy path only, and slow. */
        pipelineDebug?: boolean;
        optimise?: boolean;
        clipRGBinPipeline?: boolean;
        /** Run one colour through the pipeline at the end of `create()`. Default true. */
        validateOnCreate?: boolean;
        /** Beta. `'auto'`, 0 or false for off, 1, or a table size. */
        pixelCache?: number | 'auto' | false;
        /** `true`, `false`, or `'prefer'` to displace a LUT that would be built. */
        wasmMatrixShaper?: boolean | 'prefer';
        /** Default for `transformImages()`. */
        multicore?: boolean | PoolOptions;
        wasmShrinkRatio?: number;
        /** Bytes. Default 128 MB; 0 disables. */
        wasmMaxMemory?: number;
        verbose?: boolean;
        verboseTiming?: boolean;
        /** Bake a gamut check into the LUT. Default `'none'`. */
        lutGamutMode?: GamutMode;
        lutGamutLimit?: number;
        lutGamutMapScale?: number;
        lutGamutColor?: LabColor;
        gamutDeFn?: DeltaEFunction;
        /** @deprecated Use `lutGamutMode: 'color'`. */
        bakeLutGamut?: boolean;
        lutInputHook?: LutInputHook;
        lutOutputHook?: LutOutputHook;
        [key: string]: any;
    }

    /** A built LUT, as `getLut()` returns it and `setLut()` accepts it. */
    interface Lut {
        inputChannels?: number;
        outputChannels?: number;
        precision?: number;
        originalSignature?: string;
        [key: string]: any;
    }

    /** What `kernelInfo()` reports. Fields beyond `name` depend on the kernel. */
    interface KernelInfo {
        name: string;
        variant?: string;
        bits?: number;
        /** `'not-supported'`, `'off'`, 1, or a table size. */
        cache?: 'not-supported' | 'off' | number;
        [key: string]: any;
    }

    /** One image for `transformImages()`. Extra properties come back as `info.source`. */
    interface BatchImage {
        /** Interleaved channels; alpha, if any, last in each pixel. */
        data: Uint8ClampedArray | Uint8Array | Uint16Array;
        /** Pixels, not bytes. Inferred from `data.length` if absent. */
        pixelCount?: number;
        /** Defaults to `'image-<index>'`. */
        id?: string;
        inputHasAlpha?: boolean;
        outputHasAlpha?: boolean;
        preserveAlpha?: boolean;
        [key: string]: any;
    }

    interface BatchImageInfo<TImage extends BatchImage = BatchImage> {
        id: string;
        index: number;
        pixelCount: number;
        outputChannels: number;
        /** Wall time from the start of the call. */
        ms: number;
        /** Summed worker time for this image. It can exceed `ms`. */
        computeMs: number;
        fragments?: number;
        cancelled?: boolean;
        /** The descriptor you passed in. */
        source: TImage;
    }

    interface TransformImagesOptions<TImage extends BatchImage = BatchImage> {
        multicore?: boolean | PoolOptions;
        /** Fail if workers are unavailable. Otherwise it warns and runs sequentially. */
        requireWorkers?: boolean;
        inputHasAlpha?: boolean;
        outputHasAlpha?: boolean;
        preserveAlpha?: boolean;
        /** Fires as each image finishes. `data` is null for a cancelled image. */
        onImage?: (index: number, data: Uint8ClampedArray | Uint16Array | null, info: BatchImageInfo<TImage>) => void;
        [key: string]: any;
    }

    interface TransformImagesResult<TImage extends BatchImage = BatchImage> {
        /** Converted pixels, in the order the images were passed. */
        images: Array<Uint8ClampedArray | Uint16Array | null>;
        imageInfo: Array<BatchImageInfo<TImage>>;
        /** One flag per image, in the order passed. A cancelled image is null in `images`. */
        cancelled: boolean[];
        /** 0 when it ran on the calling thread. */
        workersUsed: number;
        tasks: number;
    }

    /**
     * A conversion between profiles. Build it once with `create()`, then
     * convert as many colours or pixels as you like.
     *
     * `transform()` is the accuracy path: one colour, every stage at full
     * precision. `array()` is the image path: with `buildLut: true` and
     * `dataFormat: 'int8'` or `'int16'` it runs the fast kernels.
     */
    class Transform {
        constructor(options?: TransformOptions);

        // ---- building ----

        /**
         * Build the pipeline between two profiles. Throws if it cannot be
         * built. A DeviceLink profile is passed alone.
         */
        create(inputProfile: ProfileOrName, outputProfile?: ProfileOrName, intent?: Intent, customStages?: CustomStage[]): void;
        /** `[profile, intent, profile, intent, ..., profile]`. */
        createMultiStage(profileChain: Array<ProfileOrName | Intent>, customStages?: CustomStage[]): void;
        /** Run one colour through the pipeline. True if the result is sound. */
        validatePipeline(formatOverride?: DataFormat): boolean;

        // ---- converting ----

        /**
         * Convert one colour at full precision. The input and result shapes
         * follow `dataFormat`: colour objects, or arrays for `'device'` and
         * the integer formats. Not for image data: use `array()`.
         */
        transform<TOutput = Color>(color: Color | ArrayLike<number>): TOutput;
        /** The same as `transform()`. */
        forward<TOutput = Color>(color: Color | ArrayLike<number>): TOutput;

        /**
         * Convert a flat array of pixels. The result container matches
         * `dataFormat`: `Uint8ClampedArray` for `'int8'`, `Uint16Array` for
         * `'int16'`, a plain array otherwise.
         * @param inputHasAlpha  every pixel has an alpha value after its channels
         * @param outputHasAlpha give each output pixel an alpha value
         * @param preserveAlpha  copy alpha across; default is "if both sides have one"
         * @param pixelCount     default: worked out from the array length
         * @param outputArray    written to and returned, if given
         */
        array<TOutput extends PixelOutput = PixelOutput>(
            inputArray: PixelInput, inputHasAlpha?: boolean, outputHasAlpha?: boolean,
            preserveAlpha?: boolean, pixelCount?: number, outputArray?: TOutput): TOutput;
        /** As `array()`, then rescaled to `outputFormat` if it differs from `dataFormat`. */
        transformArray<TOutput extends PixelOutput = PixelOutput>(
            inputArray: PixelInput, inputHasAlpha?: boolean, outputHasAlpha?: boolean,
            preserveAlpha?: boolean, pixelCount?: number, outputFormat?: ArrayOutputFormat | false,
            outputArray?: TOutput): TOutput;
        /** As `array()`, but throws if there is no LUT; it never walks the pipeline. */
        transformArrayViaLUT<TOutput extends PixelOutput = PixelOutput>(
            inputArray: PixelInput, inputHasAlpha?: boolean, outputHasAlpha?: boolean,
            preserveAlpha?: boolean, pixelCount?: number, outputArray?: TOutput): TOutput;

        /** Convert one or more images, on a worker pool when that pays. */
        transformImages<TImage extends BatchImage = BatchImage>(
            images: TImage[], options?: TransformImagesOptions<TImage>): Promise<TransformImagesResult<TImage>>;

        /**
         * Cancel one image, by id, in the batches this transform has in flight.
         * Other transforms sharing the pool are not affected. The image still
         * fires `onImage`, with `data: null` and `info.cancelled: true`.
         * @returns false if this transform has nothing in flight
         */
        cancel(id: string): boolean;
        /**
         * Cancel every batch this transform has in flight, queued or running.
         * Later batches, and other transforms, are not affected. For the whole
         * pool use the static `Transform.cancelAllPools()`.
         * @returns false if this transform has nothing in flight
         */
        cancelAll(): boolean;

        // ---- what was built ----

        inputProfile: Profile;
        outputProfile: Profile;
        inputChannels: number;
        outputChannels: number;
        usesBPC: boolean;
        usesAdaptation: boolean;
        chain: any[];
        /** True after a successful `create()` or `createMultiStage()`. */
        pipelineCreated: boolean;
        builtLut: boolean;
        /** The built LUT, or false if there is none. */
        lut: Lut | false;
        /** The kernel mode in use, after `'auto'` has been resolved. */
        lutMode: string;
        dataFormat: DataFormat;
        /** What `array()` ran last: a kernel name, `'pipeline'` or `'cache'`. */
        lastUsedKernel: string | null;
        pixelCacheUsed: number;

        /** Which kernel took this transform, or null before `create()`. */
        kernelInfo(): KernelInfo | null;
        getOptions(): TransformOptions;
        getInfo(): { [key: string]: any };
        hasLut(): boolean;
        getStageNames(includeInputsAndOutputs?: boolean, includeDebugFormat?: boolean): string[];
        chainInfo(): string;
        historyInfo(): string;
        optimiseInfo(): string;
        debugInfo(): string;
        intent2String(intent: Intent): string;

        // ---- LUT access and persistence ----

        getLut(precision?: number): Lut;
        getLut16(): Lut;
        getLut8(): Lut;
        /** Install a LUT built elsewhere. `verify` throws on a signature mismatch. */
        setLut(lut: Lut, options?: { verify?: boolean; [key: string]: any }): void;
        /** A portable LUT. `JSON.stringify(transform)` calls this. */
        toJSON(options?: { dataType?: 'u16' | 'u8'; [key: string]: any }): { [key: string]: any };
        signLut(): string | null;
        /** true: unchanged since signing. false: edited. null: not signed. */
        verifyLut(): boolean | null;

        addLutInputHook(hook: LutInputHook, where?: 'before' | 'after'): void;
        addLutOutputHook(hook: LutOutputHook, where?: 'before' | 'after'): void;
        clearLutHooks(): void;

        // ---- Lab as 16-bit values, using the profile's own encoding ----

        inputLab2Int16(L: number, a: number, b: number): number[];
        outputLab2Int16(L: number, a: number, b: number): number[];
        inputInt162Lab(uL: number, ua: number, ub: number): LabColor;
        outputInt162Lab(uL: number, ua: number, ub: number): LabColor;

        // ---- WASM memory ----

        compactWasmMemory(): void;
        /** Compact when memory exceeds this many times what the last image needed. 0 disables. */
        setWasmShrinkRatio(ratio: number): void;
        /** A ceiling in bytes. 0 disables. */
        setWasmMaxMemory(bytes: number): void;
        /** Drop the WASM kernels; the JavaScript ones take over until `create()` runs again. */
        releaseWasmMemory(): void;
        wasmMemoryBytes(): number;

        // ---- workers ----

        getWorkerInfo(options?: { [key: string]: any }): any;
        releaseWorkers(): any;
        forgetWorkers(): void;

        // ---- statics ----

        /** Start the worker pool. Rejects with the reason if it cannot. */
        static enablePool(options?: PoolOptions): Promise<any>;
        static restartPool(options?: PoolOptions): Promise<any>;
        static disablePool(): any;
        /** Cancel every batch in flight, from every transform. */
        static cancelAllPools(): void;
        static workerStats(): any;
        static poolMemory(): any;

        /**
         * Pin the defaults of an earlier version, such as `'1.5'`. `null`
         * returns to current defaults; no argument returns the active pin.
         */
        static compatibility(version?: string | null): string | null;

        /** Rescale an array from one format to another. */
        static reformat<TOutput extends PixelOutput = PixelOutput>(
            input: PixelInput, fromFormat: ArrayOutputFormat, toFormat: ArrayOutputFormat, out?: TOutput): TOutput;

        static fromJSON(input: string | object, options?: TransformOptions & { verify?: boolean }): Transform;
        static lutToJSON(lut: Lut, options?: { dataType?: 'u16' | 'u8'; [key: string]: any }): { [key: string]: any };
        static jsonToLut(input: string | object): Lut;
        static signLut(lut: Lut): string;
        static verifyLut(lutOrJson: Lut | string | object): boolean | null;

        /** Register a kernel module. See docs/deepdive/KernelContract.md. */
        static registerKernel(descriptor: { [key: string]: any }): void;
        static readonly MAX_KERNEL_DIMENSIONS: number;
        static readonly WASM_DISPATCH_MIN_PIXELS: number;
    }

    // ---------------------------------------------------------------------
    // alpha
    // ---------------------------------------------------------------------

    type AlphaArray = Uint8ClampedArray | Uint8Array | Uint16Array;

    interface FlattenOptions {
        /** `[r, g, b]` in the source encoding, 0 to the array's maximum. */
        background: number[];
        /** True if `data` is premultiplied. */
        premultiplied?: boolean;
        /** 3 drops alpha; 4 keeps it, opaque. Default 3. */
        outputChannels?: 3 | 4;
        /** Written to and returned, if given. */
        out?: AlphaArray;
    }

    /**
     * Alpha preparation for RGBA data, to run before a transform. Nothing in
     * a buffer says whether it is premultiplied, so only the caller can decide.
     */
    const alpha: {
        /** Premultiplied to straight. Keeps the alpha channel. */
        unpremultiply<TArray extends AlphaArray>(data: TArray, pixelCount?: number, out?: TArray): TArray;
        /** Straight to premultiplied. */
        premultiply<TArray extends AlphaArray>(data: TArray, pixelCount?: number, out?: TArray): TArray;
        /** Composite onto a background and discard alpha. */
        flatten(data: AlphaArray, pixelCount: number | undefined, options: FlattenOptions): AlphaArray;
    };

    // ---------------------------------------------------------------------
    // Spectral
    // ---------------------------------------------------------------------

    /** Spectral data and calculations. Loosely typed. */
    class Spectral {
        constructor();
        version: string;
        name: string;
        description: string;
        [key: string]: any;
    }
}

export = jsColorEngine;
