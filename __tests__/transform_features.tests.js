/**
 * Constructor / create features that the rest of the suite only brushes past.
 *
 *   useCurveLut     — Math.pow vs 4096-entry table; ≤1 LSB at int8
 *   custom stages   — inserted, they change colour; baked into a LUT
 *   BPC             — on ≠ off on a pair that actually applies it
 *   array() objects — the object-format batch walk (not transform())
 *   2D duotone      — Kernel2D, using the RISO pair in testbed/profiles/duo
 */

const fs = require('fs');
const path = require('path');
const { Transform, eIntent, color, eProfileType, encoding } = require('../src/main');
const Profile = require('../src/Profile');

const CMYK = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
const DUO  = path.join(__dirname, '..', 'testbed', 'profiles', 'duo',
    'RISO_MZ770_RedGreen.icc');

function gracol(){
    const p = new Profile();
    p.loadFile(CMYK);
    return p;
}

function stageNames(t){
    return t.pipeline.map(s => s.stageName);
}

describe('useCurveLut', () => {

    // AdobeRGB is a simple gamma-2.2 matrix. sRGB's piecewise TRC never
    // takes this option — the table only replaces Math.pow. Matrix-shaper
    // off keeps those stages in the pipeline so we can name them.

    function pair(useCurveLut){
        const t = new Transform({
            dataFormat: 'int8',
            buildLut: false,
            useCurveLut,
            wasmMatrixShaper: 'off',
        });
        t.create('*AdobeRGB', '*sRGB', eIntent.relative);
        return t;
    }

    test('swaps Math.pow gamma for the table stages', () => {
        const exact = stageNames(pair(false));
        const table = stageNames(pair(true));
        expect(exact).toContain('stage_Gamma_Inverse');
        expect(exact).not.toContain('stage_Gamma_Inverse_Table');
        expect(table).toContain('stage_Gamma_Inverse_Table');
        expect(table).not.toContain('stage_Gamma_Inverse');
    });

    test('int8 output stays within 1 LSB of Math.pow', () => {
        const exact = pair(false);
        const table = pair(true);
        // Includes AdobeRGB 255,0,0 — a matrix can push a channel past 1.0,
        // which used to index off the table and come back 0.
        const px = new Uint8ClampedArray([0, 0, 0, 18, 18, 18, 128, 64, 32, 255, 0, 0, 255, 255, 255]);
        const a = exact.array(px, false, false);
        const b = table.array(px, false, false);
        expect(exact.lastUsedKernel).toBe('pipeline');
        expect(table.lastUsedKernel).toBe('pipeline');
        expect(a.length).toBe(b.length);
        let max = 0;
        for(let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
        expect(max).toBeLessThanOrEqual(1);
    });
});

describe('custom stages', () => {

    const desaturate = {
        description: 'Convert to Grey',
        location: 'PCS',
        stageData: null,
        stageFn: function(input, data, stage){
            if(stage.inputEncoding === encoding.PCSXYZ){
                input[0] = input[1];
                input[2] = input[1];
            } else {
                input[1] = 0.5;
                input[2] = 0.5;
            }
            return input;
        },
    };

    test('lands in the pipeline and changes the colour', () => {
        const plain = new Transform({ dataFormat: 'object' });
        plain.create('*sRGB', gracol(), eIntent.relative);

        const grey = new Transform({ dataFormat: 'object' });
        grey.create('*sRGB', gracol(), eIntent.relative, [desaturate]);

        expect(stageNames(grey).some(n => n.indexOf('Custom:Convert to Grey') === 0)).toBe(true);
        expect(stageNames(plain).some(n => n.indexOf('Custom:') === 0)).toBe(false);

        const red = color.RGB(220, 30, 30);
        const a = plain.transform(red);
        const b = grey.transform(red);
        expect(b.C === a.C && b.M === a.M && b.Y === a.Y && b.K === a.K).toBe(false);
        // A grey PCS should not still be a red: magenta and yellow drop.
        expect(b.M + b.Y).toBeLessThan(a.M + a.Y);
    });

    test('is baked into a LUT — the table disagrees with a stage-free one', () => {
        const opts = { dataFormat: 'int8', buildLut: true, wasmMatrixShaper: 'off' };
        const plain = new Transform(opts);
        plain.create('*sRGB', '*AdobeRGB', eIntent.relative);
        const grey = new Transform(opts);
        grey.create('*sRGB', '*AdobeRGB', eIntent.relative, [desaturate]);

        const px = new Uint8ClampedArray([220, 30, 30]);
        const a = plain.array(px, false, false);
        const b = grey.array(px, false, false);
        expect(plain.lastUsedKernel).toBe('kernel3D');
        expect(Array.from(a)).not.toEqual(Array.from(b));
        expect(grey.lastUsedKernel).toBe('kernel3D');
    });
});

describe('BPC', () => {

    test('on ≠ off for sRGB → GRACoL relative, and usesBPC says so', () => {
        const off = new Transform({ dataFormat: 'object', BPC: false });
        off.create('*sRGB', gracol(), eIntent.relative);
        const on = new Transform({ dataFormat: 'object', BPC: true });
        on.create('*sRGB', gracol(), eIntent.relative);

        expect(on.usesBPC).toBe(true);
        expect(off.usesBPC).toBe(false);
        expect(stageNames(on)).toContain('stage_BPC');
        expect(stageNames(off)).not.toContain('stage_BPC');

        // Device 0,0,0 maps to the same K=100 either way — both black
        // points crush there. A dark grey is where the scale shows.
        const dark = color.RGB(16, 16, 16);
        const a = off.transform(dark);
        const b = on.transform(dark);
        expect(b.C === a.C && b.M === a.M && b.Y === a.Y && b.K === a.K).toBe(false);
    });

    test('does not apply to a matrix → matrix pair, even when asked', () => {
        const t = new Transform({ dataFormat: 'object', BPC: true });
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(t.usesBPC).toBe(false);
    });
});

describe('array() of colour objects', () => {

    // transform() is covered elsewhere. This is the batch walk for a
    // real conversion. Identity object batches are in transform_identity
    // (15b): those bind a clone onto kernel.arrayFn.

    test('object format walks the pipeline per element and matches transform()', () => {
        const t = new Transform({ dataFormat: 'object' });
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);

        const batch = [
            color.RGB(0, 0, 0),
            color.RGB(220, 30, 30),
            color.RGB(255, 255, 255),
        ];
        const out = t.array(batch);
        expect(t.lastUsedKernel).toBe('pipeline');
        expect(out.length).toBe(3);
        expect(out[1].type).toBe(batch[1].type);
        for(let i = 0; i < batch.length; i++){
            const one = t.transform(batch[i]);
            expect(out[i].R).toBe(one.R);
            expect(out[i].G).toBe(one.G);
            expect(out[i].B).toBe(one.B);
        }
    });
});

describe('2D duotone', () => {

    test('RISO RedGreen loads and Kernel2D takes the LUT batch', () => {
        expect(fs.existsSync(DUO)).toBe(true);
        const duo = new Profile();
        duo.loadFile(DUO);
        expect(duo.loaded).toBe(true);
        expect(duo.colorSpace).toBe('2CLR');
        expect(duo.type).toBe(eProfileType.Duo);

        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create(duo, '*sRGB', eIntent.relative);
        expect(t.inputChannels).toBe(2);

        const px = new Uint8ClampedArray([0, 0, 90, 180, 255, 255]);
        const out = t.array(px, false, false);
        expect(out.length).toBe(9);
        expect(t.lastUsedKernel).toBe('kernel2D');
    });
});
