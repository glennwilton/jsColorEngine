const { loadTestData, getInput, getOutput } = require('GATCS');
const defs = require("../src/def");

var lab2DeviceTests = [
    {
        intent: defs.eIntent.absolute,
        BPC: false,
        prefix: '*_to_',
        suffix: '_Absolute.it8',
        input: '*lab',
        output: '{profile}'
    },
    {
        intent: defs.eIntent.relative,
        BPC: false,
        prefix: '*_to_',
        suffix: '_Relative.it8'
    },
    {
        intent: defs.eIntent.perceptual,
        BPC: false,
        prefix: '*_to_',
        suffix: '_Perceptual.it8'
    },
    {
        intent: defs.eIntent.perceptual,
        BPC: true,
        prefix: '*_to_',
        suffix: '_Perceptual_BPC.it8'
    },
    {
        intent: defs.eIntent.relative,
        BPC: true,
        prefix: '*_to_',
        suffix: '_Relative_BPC.it8'
    },
];

var device2LabTests = [
    {
        intent: defs.eIntent.absolute,
        BPC: false,
        prefix: '',
        suffix: '_to_*_Absolute.it8'
    },
    {
        intent: defs.eIntent.relative,
        BPC: false,
        prefix: '',
        suffix: '_to_*_Relative.it8'
    },
    {
        intent: defs.eIntent.perceptual,
        BPC: false,
        prefix: '',
        suffix: '_to_*_Perceptual.it8'
    },
    {
        intent: defs.eIntent.perceptual,
        BPC: true,
        prefix: '',
        suffix: '_to_*_Perceptual_BPC.it8'
    },
    {
        intent: defs.eIntent.relative,
        BPC: true,
        prefix: '',
        suffix: '_to_*_Relative_BPC.it8'
    },
];

var profiles = [
    {
        profile: 'AdobeRGB1998.icc'
    }
];


lab2DeviceTests.forEach(function (lab2DeviceTest) {

    let inputProfile = new Profile('*lab');

    profiles.forEach(function (profile) {
        let outputProfile = new Profile(profiles);
        let input = getInput(inputProfile, lab2DeviceTest.intent, lab2DeviceTest.BPC);
        let output = getOutput(outputProfile, lab2DeviceTest.intent, lab2DeviceTest.BPC);
        loadTestData(input, output);
    });
});


