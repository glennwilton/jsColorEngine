/**
 * CGATS.17 reader for the lcms_compat harness.
 *
 * CGATS.17 is the industry-standard tabular-exchange format for ICC
 * measurement and target-swap data. It's what lcms's transicc emits,
 * what Chromix / ColorThink / every spectrophotometer driver emits,
 * and what prepress bureaus exchange over email. Format:
 *
 *     CGATS.17                              <-- magic line (ignored here)
 *     ORIGINATOR  "..."                     <-- header keyword lines
 *     NUMBER_OF_FIELDS   7
 *     BEGIN_DATA_FORMAT
 *     SAMPLE_ID IN_RGB_R IN_RGB_G ...       <-- field names (one or
 *     END_DATA_FORMAT                       <-- more whitespace-sep lines)
 *     NUMBER_OF_SETS     9261
 *     BEGIN_DATA
 *       0   0.0   0.0   0.0   50.0  0.0  0.0   <-- rows
 *       1   0.0   0.0  13.0   ...
 *     END_DATA
 *
 * No escapes, no quoting surprises. Comments start with `#`. All
 * whitespace-separated. This parser is intentionally tolerant — it
 * treats `NUMBER_OF_*` headers as hints (we verify against row count)
 * rather than truth.
 *
 * Provenance: salvaged + renamed from the prototype in
 * `speed_tests/GATCS.js`. The `data`-as-free-variable bug in the
 * original `getInput` / `getOutput` helpers is fixed here; each row is
 * passed explicitly.
 */

'use strict';

/**
 * @typedef {Object} CGATSFile
 * @property {string[]} fields  - column names from BEGIN_DATA_FORMAT
 * @property {Object[]} rows    - parsed rows (keyed by field name, values are Number)
 * @property {Object}   header  - keyword/value pairs from the CGATS header (strings)
 */

/**
 * Parse a CGATS.17 text buffer into a structured object.
 *
 * @param {string} content  - raw file contents
 * @returns {CGATSFile}
 */
function parseCGATS(content) {
    const lines = content.split(/\r?\n/);
    const fields = [];
    const rows = [];
    const header = {};

    let mode = 'header';

    for (let raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) continue;

        if (line === 'BEGIN_DATA_FORMAT') { mode = 'fields'; continue; }
        if (line === 'END_DATA_FORMAT')   { mode = 'header'; continue; }
        if (line === 'BEGIN_DATA')        { mode = 'data';   continue; }
        if (line === 'END_DATA')          { mode = 'done';   continue; }

        if (mode === 'fields') {
            // Field names may be split across lines — accumulate.
            for (const token of line.split(/\s+/)) {
                if (token) fields.push(token);
            }
        } else if (mode === 'data') {
            const values = line.split(/\s+/);
            if (values.length !== fields.length) {
                throw new Error(
                    'CGATS row has ' + values.length + ' columns, expected ' +
                    fields.length + ' (fields=[' + fields.join(',') + '])'
                );
            }
            const row = {};
            for (let i = 0; i < fields.length; i++) {
                const n = Number(values[i]);
                row[fields[i]] = Number.isFinite(n) ? n : values[i];
            }
            rows.push(row);
        } else if (mode === 'header') {
            // Header lines are `KEYWORD value` or `KEYWORD "quoted value"`.
            const m = line.match(/^([A-Z_0-9][A-Z_0-9.]*)\s+(.*)$/i);
            if (m) {
                let val = m[2].trim();
                if (val.startsWith('"') && val.endsWith('"')) {
                    val = val.slice(1, -1);
                }
                header[m[1]] = val;
            }
        }
    }

    return { fields, rows, header };
}

/**
 * Build a jsColorEngine input color object from a CGATS row.
 *
 * Infers which fields to read from the profile's colour space. The
 * CGATS field naming convention follows lcms/transicc output:
 *
 *     LAB  -> IN_L, IN_A, IN_B                  (but note: some files
 *             use IN_LAB_L, IN_LAB_A, IN_LAB_B)
 *     GRAY -> IN_GRAY
 *     2CLR -> IN_CH1, IN_CH2
 *     RGB  -> IN_RGB_R, IN_RGB_G, IN_RGB_B
 *     CMYK -> IN_CMYK_C, IN_CMYK_M, IN_CMYK_Y, IN_CMYK_K
 *
 * @param {Object} row           - a single parsed CGATS data row
 * @param {string} colorSpace    - profile.colorSpace: 'LAB'|'GRAY'|'2CLR'|'RGB'|'CMYK'
 * @param {{RGB:Function, Lab:Function, CMYK:Function, Gray:Function, Duo:Function}} convert
 *                               - jsColorEngine's `convert` factory (from src/main)
 * @returns {{input:Object, description:string}}
 */
function rowToInput(row, colorSpace, convert) {
    let input, description;

    switch (colorSpace) {
        case 'LAB':
            input = convert.Lab(firstOf(row, 'IN_LAB_L', 'IN_L'),
                                firstOf(row, 'IN_LAB_A', 'IN_A'),
                                firstOf(row, 'IN_LAB_B', 'IN_B'), false);
            description = input.L + ', ' + input.a + ', ' + input.b;
            break;
        case 'GRAY':
            input = convert.Gray(row.IN_GRAY, false);
            description = '' + row.IN_GRAY;
            break;
        case '2CLR':
            input = convert.Duo(row.IN_CH1 * 100, row.IN_CH2 * 100, false);
            description = row.IN_CH1 + ', ' + row.IN_CH2;
            break;
        case 'RGB':
            input = convert.RGB(row.IN_RGB_R, row.IN_RGB_G, row.IN_RGB_B, false);
            description = row.IN_RGB_R + ', ' + row.IN_RGB_G + ', ' + row.IN_RGB_B;
            break;
        case 'CMYK':
            input = convert.CMYK(row.IN_CMYK_C, row.IN_CMYK_M, row.IN_CMYK_Y, row.IN_CMYK_K, false);
            description = row.IN_CMYK_C + ', ' + row.IN_CMYK_M + ', ' +
                          row.IN_CMYK_Y + ', ' + row.IN_CMYK_K;
            break;
        default:
            throw new Error('rowToInput: unsupported colorSpace "' + colorSpace + '"');
    }

    return { input, description };
}

/**
 * Build a jsColorEngine output color object from a CGATS row. Same
 * naming convention as `rowToInput` but with OUT_ prefixes. Used to
 * wrap the "expected output" side of a reference file so we can diff
 * (jsCE-computed output, lcms-reference output) in a common shape.
 *
 * @param {Object} row
 * @param {string} colorSpace
 * @param {Object} convert
 * @returns {{output:Object, description:string}}
 */
function rowToOutput(row, colorSpace, convert) {
    let output, description;

    switch (colorSpace) {
        case 'LAB':
            output = convert.Lab(firstOf(row, 'OUT_LAB_L', 'OUT_L'),
                                 firstOf(row, 'OUT_LAB_A', 'OUT_A'),
                                 firstOf(row, 'OUT_LAB_B', 'OUT_B'), false);
            description = output.L + ', ' + output.a + ', ' + output.b;
            break;
        case 'GRAY':
            output = convert.Gray(row.OUT_GRAY, false);
            description = '' + row.OUT_GRAY;
            break;
        case '2CLR':
            output = convert.Duo(row.OUT_CH1 * 100, row.OUT_CH2 * 100, false);
            description = row.OUT_CH1 + ', ' + row.OUT_CH2;
            break;
        case 'RGB':
            output = convert.RGB(row.OUT_RGB_R, row.OUT_RGB_G, row.OUT_RGB_B, false);
            description = row.OUT_RGB_R + ', ' + row.OUT_RGB_G + ', ' + row.OUT_RGB_B;
            break;
        case 'CMYK':
            output = convert.CMYK(row.OUT_CMYK_C, row.OUT_CMYK_M, row.OUT_CMYK_Y, row.OUT_CMYK_K, false);
            description = row.OUT_CMYK_C + ', ' + row.OUT_CMYK_M + ', ' +
                          row.OUT_CMYK_Y + ', ' + row.OUT_CMYK_K;
            break;
        default:
            throw new Error('rowToOutput: unsupported colorSpace "' + colorSpace + '"');
    }

    return { output, description };
}

function firstOf(row, ...keys) {
    for (const k of keys) {
        if (k in row) return row[k];
    }
    throw new Error('CGATS row missing all of: ' + keys.join(', '));
}

module.exports = {
    parseCGATS,
    rowToInput,
    rowToOutput,
};
