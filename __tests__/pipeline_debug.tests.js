/**
 * pipelineDebug — coverage guard.
 *
 * This path had no tests at all, which is how the v1.5.5 stages split broke
 * it silently: `addDebugHistory` moved to src/stages.js while the module-scope
 * `data2String` helper it calls stayed behind in src/Transform.js. Every one
 * of the 488 tests still passed, because none of them turned pipelineDebug on.
 *
 * These are deliberately shallow — the point is that the debug walk executes
 * end to end and agrees with the normal walk, so a missing helper or a broken
 * history cannot pass unnoticed again.
 */

const { Transform, eIntent } = require('../src/main');
const defs = require('../src/def');

const LAB = defs.eColourType.Lab;
const D50 = defs.illuminant.d50;

function labColour() {
    return { type: LAB, L: 50, a: 12, b: -30, whitePoint: D50 };
}

describe('pipelineDebug', () => {

    test('produces the same result as a non-debug transform', () => {
        const plain = new Transform({ dataFormat: 'object', buildLut: false });
        plain.create('*Lab', '*sRGB', eIntent.relative);

        const debugged = new Transform({ dataFormat: 'object', buildLut: false, pipelineDebug: true });
        debugged.create('*Lab', '*sRGB', eIntent.relative);

        expect(debugged.transform(labColour())).toEqual(plain.transform(labColour()));
    });

    test('records a history entry per stage and renders it as text', () => {
        const debugged = new Transform({ dataFormat: 'object', buildLut: false, pipelineDebug: true });
        debugged.create('*Lab', '*sRGB', eIntent.relative);
        debugged.transform(labColour());

        // input colour plus one entry per stage
        expect(debugged.pipelineHistory.length).toBe(debugged.pipeline.length + 1);

        // data2String() is exercised here — this is what silently went missing
        const text = debugged.historyInfo();
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/undefined/);
    });

    test('survives validateOnCreate, which runs a probe colour through the debug walk', () => {
        expect(() => {
            const debugged = new Transform({
                dataFormat: 'object', buildLut: false, pipelineDebug: true, validateOnCreate: true
            });
            debugged.create('*Lab', '*sRGB', eIntent.relative);
        }).not.toThrow();
    });

    test('works on an int8 array pipeline too', () => {
        const plain = new Transform({ dataFormat: 'int8', buildLut: false });
        plain.create('*sRGB', '*Lab', eIntent.relative);

        const debugged = new Transform({ dataFormat: 'int8', buildLut: false, pipelineDebug: true });
        debugged.create('*sRGB', '*Lab', eIntent.relative);

        expect(debugged.transform([200, 30, 40])).toEqual(plain.transform([200, 30, 40]));
        expect(debugged.historyInfo()).not.toMatch(/undefined/);
    });
});
