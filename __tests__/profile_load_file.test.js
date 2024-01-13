/**
 *  Test Loading of ICC profiles
 */

let Profile = require('../src/Profile');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const testServerPort = 3000;

let realProfile = path.join(__dirname, './GRACoL2006_Coated1v2.icc');
let realProfileName = 'GRACoL2006_Coated1v2.icc';
let nonExistingProfile = path.join(__dirname, '../IDoNotExist.icc');
let profileURL = 'http://localhost:' + testServerPort + '/giveMeTheFile';
let invalidProfileURL = 'http://localhost:' + testServerPort + '/hereBeDragons';

// Function to create a simple server
function createServer(port) {
    const server = http.createServer((req, res) => {

        const parsedUrl = url.parse(req.url, true);
        if (parsedUrl.pathname === '/giveMeTheFile') {
            fs.readFile(realProfile, (err, data) => {
                if (err) {
                    res.writeHead(500);
                    res.end('Server Error');
                    return;
                }
                res.writeHead(200);
                res.end(data);
            });
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    server.listen(port);
    //console.log('Server running at http://localhost:' + port +'/');
    return server;
}

// Jest global setup and teardown
let server;
beforeAll(() => {
    // Start server before all tests
    server = createServer(testServerPort);
});

afterAll(() => {
    // Close server after all tests
    server.close();
    //console.log('Server stopped');
});


test('Loading profile from buffer', done => {
    let profile = new Profile();
    let buffer = fs.readFileSync(realProfile);

    profile.loadBinary(buffer, function (profile) {
        try {
            expect(profile.loaded).toBe(true);
            expect(profile.name).toBe(realProfileName);
            done();
        } catch (error) {
            done(error);
        }
    });
});


test('Loading profile from buffer via generic loader', done => {
    let profile = new Profile();
    let buffer = fs.readFileSync(realProfile);

    profile.load(buffer, function (profile) {
        try {
            expect(profile.loaded).toBe(true);
            expect(profile.name).toBe(realProfileName);
            done();
        } catch (error) {
            done(error);
        }
    });
});

test('Loading profile from base64', done => {
    let profile = new Profile();
    let buffer = fs.readFileSync(realProfile);
    const base64String = buffer.toString('base64');
    profile.loadBase64(base64String, function (profile) {
        try {
            expect(profile.loaded).toBe(true);
            expect(profile.name).toBe(realProfileName);
            done();
        } catch (error) {
            done(error);
        }
    });
});

test('Loading profile from base64 via generic loader', done => {
    let profile = new Profile();
    let buffer = fs.readFileSync(realProfile);
    const base64String = buffer.toString('base64');
    profile.load('data:' + base64String, function (profile) {
        try {
            expect(profile.loaded).toBe(true);
            expect(profile.name).toBe(realProfileName);
            done();
        } catch (error) {
            done(error);
        }
    });
});

test('Loading profile from file', done => {
    let profile = new Profile();
    profile.loadFile(realProfile, function (profile) {
        try {
            expect(profile.loaded).toBe(true);
            expect(profile.name).toBe(realProfileName);
            done();
        } catch (error) {
            done(error);
        }
    });
});

test('Loading profile from file via generic loader', done => {
    let profile = new Profile();
    profile.load('file:' + realProfile, function (profile) {
        try {
            expect(profile.loaded).toBe(true);
            expect(profile.name).toBe(realProfileName);
            done();
        } catch (error) {
            done(error);
        }
    });
});
test('Loading profile from file - but not found', done => {
    let profile = new Profile();
    profile.loadFile(nonExistingProfile, function (profile) {
        try {
            expect(profile.loaded).toBe(false);
            done();
        } catch (error) {
            done(error);
        }
    });
});
test('Loading profile from url', done => {
    let profile = new Profile();
    profile.loadURL(profileURL, function (profile) {
        try {
            expect(profile.loaded).toBe(true);
            expect(profile.name).toBe(realProfileName);
            done();
        } catch (error) {
            done(error);
        }
    });
});

test('Loading profile from url - but returns 404', done => {
    let profile = new Profile();
    profile.loadURL(invalidProfileURL, function (profile) {
        try {
            expect(profile.loadError).toBe(true);
            expect(profile.lastError.text).toBe('Response status was 404');
            done();
        } catch (error) {
            done(error);
        }
    });
});


test('Loading profile from url (ASYNC)', async () => {
    let profile = new Profile();
    await profile.loadPromise(profileURL)

    expect(profile.loaded).toBe(true);
    expect(profile.name).toBe(realProfileName);
});