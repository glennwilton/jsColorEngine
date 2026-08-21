
const path = require('path');
const fs = require('fs');
const {convert} = require("../src/main");
const testDataFolder = path.join(__dirname, './testData');


async function loadTestData(dataFilename, tests, type) {

    try {
        const filePromises = tests.map(async test => {
            var file = testDataFolder + test.prefix.replace('*',type) + dataFilename + test.suffix.replace('*',type);

            // read file sync
            const contents = fs.readFileSync(file, 'utf8');

            return {
                intent: test.intent,
                BPC: test.BPC,
                url: url,
                contents: contents,
                CGATS: false
            };
        });

        const testsWithData = await Promise.all(filePromises);

        // parse
        testsWithData.forEach(test => {
            test.CGATS = parseCGATS(test.contents);
        });

        return testsWithData;

    } catch (error) {
        console.error("Error loading files:", error);
        return [];
    }
}


function parseCGATS(content) {
    const lines = content.split('\n');
    let dataFormat = [];
    let inDataFormatSection = false;
    let inDataSection = false;
    let data = [];

    lines.forEach(line => {
        line = line.trim();

        if (line.startsWith('BEGIN_DATA_FORMAT')) {
            inDataFormatSection = true;
            inDataSection = false;
        } else if (line.startsWith('END_DATA_FORMAT')) {
            inDataFormatSection = false;
        } else if (line.startsWith('BEGIN_DATA')) {
            inDataSection = true;
        } else if (line.startsWith('END_DATA')) {
            inDataSection = false;
        } else {
            if (inDataFormatSection) {
                // Parse the data format
                dataFormat = line.split(/\s+/);
            } else if (inDataSection) {
                // Parse the data line
                const values = line.split(/\s+/);
                let dataEntry = {};
                dataFormat.forEach((key, index) => {
                    dataEntry[key] = parseFloat(values[index]);
                });
                data.push(dataEntry);
            }
        }
    });

    return {
        data,
        dataFormat
    };
}

function getInput(inputProfile){
    var input, description;
    switch (inputProfile.colorSpace){
        case 'LAB':
            input = convert.Lab(data.IN_L, data.IN_A, data.IN_B, false);
            description = data.IN_L + ', ' + data.IN_A + ', ' + data.IN_B;
            break;
        case 'GRAY':
            input = convert.Gray(data.IN_GRAY , false);
            description = data.IN_GRAY;
            break;
        case '2CLR':
            data.IN_CH1 *= 100;
            data.IN_CH2 *= 100;
            input = convert.Duo(data.IN_CH1 , data.IN_CH2, false);
            description = data.IN_CH1 + ', ' + data.IN_CH2;
            break;
        case 'RGB':
            input = convert.RGB(data.IN_RGB_R, data.IN_RGB_G, data.IN_RGB_B, false);
            description = data.IN_RGB_R + ', ' + data.IN_RGB_G + ', ' + data.IN_RGB_B;
            break;
        case 'CMYK':
            input = convert.CMYK(data.IN_CMYK_C, data.IN_CMYK_M, data.IN_CMYK_Y, data.IN_CMYK_K, false);
            description = data.IN_CMYK_C + ', ' + data.IN_CMYK_M + ', ' + data.IN_CMYK_Y + ', ' + data.IN_CMYK_K;
            break;
        default:
            throw  new Error('Unknown color space ' + inputProfile.colorSpace);

    }


    return {
        input: input,
        description: description
    };
}

function getOutput(outputProfile){
    var output, description;
    switch (outputProfile.colorSpace){
        case 'LAB':
            output = convert.Lab(data.OUT_L, data.OUT_A, data.OUT_B, false);
            description = data.OUT_L + ', ' + data.OUT_A + ', ' + data.OUT_B;
            break;
        case 'GRAY':
            output = convert.Gray(data.OUT_GRAY , false);
            description = data.OUT_GRAY;
            break;
        case '2CLR':
            output = convert.Duo(data.OUT_CH1 , data.OUT_CH2, false);
            output.OUT_CH1 *= 100;
            output.OUT_CH2 *= 100;
            description = data.OUT_CH1 + ', ' + data.OUT_CH2;
            break;
        case 'RGB':
            output = convert.RGB(data.OUT_RGB_R, data.OUT_RGB_G, data.OUT_RGB_B, false);
            description = data.OUT_RGB_R + ', ' + data.OUT_RGB_G + ', ' + data.OUT_RGB_B;
            break;
        case 'CMYK':
            output = convert.CMYK(data.OUT_CMYK_C, data.OUT_CMYK_M, data.OUT_CMYK_Y, data.OUT_CMYK_K, false);
            description = data.OUT_CMYK_C + ', ' + data.OUT_CMYK_M + ', ' + data.OUT_CMYK_Y + ', ' + data.OUT_CMYK_K;
            break;
        default:
            throw  new Error('Unknown color space ' + outputProfile.colorSpace);

    }


    return {
        output: output,
        description: description
    };
}


module.exports = {
    loadTestData: loadTestData,
    parseCGATS: parseCGATS,
    getInput: getInput,
    getOutput: getOutput
};