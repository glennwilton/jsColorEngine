/**
 * These should all fail and throw errors
 */

const {Profile, Transform, eIntent, color, eColourType} = require('../src/main');

function incorrectLabInput() {
    let rgb2lab = new Transform();
    rgb2lab.create('*lab', '*srgb', eIntent.absolute);
    let input = color.RGB(200,150,50);
    rgb2lab.transform(input);
}

test('incorrect Lab Input', () => {
    expect(incorrectLabInput).toThrow('stage_cmsLab_to_LabD50: input is not of type Lab');
});

function inputProfileNotLoaded() {
    let inputProfile = new Profile();
    let testTransform = new Transform();
    testTransform.create( inputProfile,'*lab',  eIntent.absolute);
}




test('input Profile Not Loaded', () => {
    expect(inputProfileNotLoaded).toThrow('Profile 1 in chain is not loaded');
});


function outputProfileNotLoaded() {
    let outputProfile = new Profile();
    let testTransform = new Transform();
    testTransform.create('*lab', outputProfile, eIntent.absolute);
}

test('output Profile Not Loaded', () => {
    expect(outputProfileNotLoaded).toThrow('Profile 2 in chain is not loaded');
});


function outputProfileNotAProfile() {
    let outputProfile = {};
    let testTransform = new Transform();
    testTransform.create('*lab', outputProfile, eIntent.absolute);
}

test('output Profile is not a profile', () => {
    expect(outputProfileNotAProfile).toThrow('Profile 2 in chain is not a Profile');
});


function inputProfileNotAProfile() {
    let inputProfile = {};
    let testTransform = new Transform();
    testTransform.create( inputProfile, '*lab', eIntent.absolute);
}

test('input Profile is not a profile', () => {
    expect(inputProfileNotAProfile).toThrow('Profile 1 in chain is not a Profile');
});


function incorrectVirtualProfileString() {
    let testTransform = new Transform();
    testTransform.create( 'lab', '*lab', eIntent.absolute);
}

test('incorrect Virtual Profile String', () => {
    expect(incorrectVirtualProfileString).toThrow('Profile 1 is a string. Virtual profiles must be prefixed with "*"');
});

function multiStageNotArray() {
    let testTransform = new Transform();
    testTransform.createMultiStage('*lab', eIntent.absolute);
}
test('multiStage Not Array', () => {
    expect(multiStageNotArray).toThrow('Invalid profileChain, must be an array');
});


function multiStageNoOutputProfile() {
    let testTransform = new Transform();
    testTransform.createMultiStage(['*lab', eIntent.absolute]);
}

test('multiStage No Output Profile', () => {
    expect(multiStageNoOutputProfile).toThrow('Invalid profileChain, must have at least 3 items [profile, intent, profile]');
});

function multiStageMissingLastItem() {
    let testTransform = new Transform();
    testTransform.createMultiStage(['*lab', eIntent.absolute, '*srgb', eIntent.absolute]);
}

test('multiStage Missing Last Item', () => {
    expect(multiStageMissingLastItem).toThrow('Last step in chain is not a Profile');
});

function intentIsAString() {
    let testTransform = new Transform();
    testTransform.create('*lab', '*srgb', 'absolute');
}

test('Intent is a string', () => {
    expect(intentIsAString).toThrow('Intent 1 in chain is not a number');
});

function invalidIntent() {
    let testTransform = new Transform();
    testTransform.create('*lab', '*srgb', 9);
}

test('Intent is invalid number', () => {
    expect(invalidIntent).toThrow('Intent 1 in chain is not a valid intent');
});