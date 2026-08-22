/**
 * Node copy of samples/bench/content.js — same kinds, same JPEG.
 * Keep the two files in lockstep.
 */
'use strict';

var fs   = require('fs');
var path = require('path');

var DEFAULT_KIND = 'photo-5';
var PHOTO_FILE = path.join(__dirname, '..', 'release_matrix', 'images',
    'jacek-dylag-559115_STRAWBERRIES-unsplash.jpg');

function lcgStep(seed) {
    return (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
}

function genLegacyNoise(buf) {
    var seed = 0x13579bdf;
    for (var i = 0; i < buf.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
    }
}

function genNoise(buf) {
    var seed = 0x13579bdf;
    for (var i = 0; i < buf.length; i++) {
        seed = lcgStep(seed);
        buf[i] = (seed >>> 23) & 0xff;
    }
}

function genSolid(buf, npx, channels) {
    var seed = 0x13579bdf;
    var px = new Uint8Array(4);
    var c, p;
    for (c = 0; c < 4; c++) {
        seed = lcgStep(seed);
        px[c] = (seed >>> 23) & 0xff;
    }
    for (p = 0; p < npx; p++) {
        for (c = 0; c < channels; c++) buf[p * channels + c] = px[c];
    }
}

var photoRgb = null;
var photoCmyk = null;

function setPhotoRgb(data, npx) {
    photoRgb = { data: data, npx: npx };
}

function setPhotoCmyk(data, npx) {
    photoCmyk = { data: data, npx: npx };
}

function tilePhoto(buf, npx, channels) {
    var src = channels === 4 ? photoCmyk : photoRgb;
    if (!src) {
        genSolid(buf, npx, channels);
        return;
    }
    var have = src.npx;
    var plane = src.data;
    for (var p = 0; p < npx; p++) {
        var s = (p % have) * channels;
        for (var c = 0; c < channels; c++) buf[p * channels + c] = plane[s + c];
    }
}

function blendNoise(buf, percent) {
    var noise = new Uint8ClampedArray(buf.length);
    genNoise(noise);
    var t = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    for (var i = 0; i < buf.length; i++) {
        buf[i] = Math.round(buf[i] * (1 - t) + noise[i] * t);
    }
}

function parseContentKind(kind) {
    if (kind === 'solid' || kind === 'photo' || kind === 'noise' || kind === 'legacy') return kind;
    var m = String(kind || '').match(/^(photo|solid)-(\d+)$/);
    if (m) return { base: m[1], noisy: Number(m[2]) };
    return { base: 'photo', noisy: 5 };
}

function buildInput(channels, pixelCount, kind) {
    var arr = new Uint8ClampedArray(pixelCount * channels);
    var parsed = parseContentKind(kind || DEFAULT_KIND);
    if (parsed === 'legacy') genLegacyNoise(arr);
    else if (parsed === 'noise') genNoise(arr);
    else if (parsed === 'solid') genSolid(arr, pixelCount, channels);
    else if (parsed === 'photo') tilePhoto(arr, pixelCount, channels);
    else {
        if (parsed.base === 'solid') genSolid(arr, pixelCount, channels);
        else tilePhoto(arr, pixelCount, channels);
        if (parsed.noisy > 0) blendNoise(arr, parsed.noisy);
    }
    return arr;
}

async function ready() {
    if (photoRgb) return photoRgb;
    var loadImage = require('canvas').loadImage;
    var createCanvas = require('canvas').createCanvas;
    var image = await loadImage(PHOTO_FILE);
    var canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    var rgba = canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data;
    var npx = image.width * image.height;
    var rgb = new Uint8ClampedArray(npx * 3);
    for (var p = 0, i = 0; p < npx; p++, i += 4) {
        rgb[p * 3]     = rgba[i];
        rgb[p * 3 + 1] = rgba[i + 1];
        rgb[p * 3 + 2] = rgba[i + 2];
    }
    setPhotoRgb(rgb, npx);
    return { npx: npx, width: image.width, height: image.height };
}

function photoPlane() {
    return photoRgb;
}

module.exports = {
    DEFAULT_KIND: DEFAULT_KIND,
    buildInput: buildInput,
    ready: ready,
    setPhotoCmyk: setPhotoCmyk,
    photoPlane: photoPlane,
    parseContentKind: parseContentKind,
};
