const path = require('path');

var config = {
    mode: 'development',
    entry: './src/main.js',
    output: {
        hashFunction: "sha256",
        filename: 'jsColorEngine.js',
        path: path.resolve(__dirname, './package'),
        libraryTarget: 'umd',
        // Make the UMD wrapper safe in Node, web workers, and the main browser
        // window. Webpack 5's default of 'self' breaks `require()` in Node
        // because the very first thing the wrapper does is read `self`, which
        // is undefined outside browser contexts. See GitHub issue #2.
        globalObject: "typeof self !== 'undefined' ? self : this"
    },
    externals: {
        fs:    "commonjs fs",
        path:  "commonjs path",
        utils:  "commonjs utils",
    },
    externalsPresets: {
        node: true,
    },
}

module.exports = (env, argv) => {
    if (argv.mode === 'development') {
        config.devtool = 'source-map';
        config.output.path = path.resolve(__dirname, './dev')
        if (env && env.TARGET_WEB) {
            config.output.libraryTarget = 'var';
            config.output.library = 'jsColorEngine';
            config.output.filename = 'jsColorEngineWeb.js';
            config.output.path = path.resolve(__dirname, './browser-dev');
        }
    }

    if (argv.mode === 'production') {
        config.output.path = path.resolve(__dirname, './build')
        if (env && env.TARGET_WEB) {
            config.output.libraryTarget = 'var';
            config.output.library = 'jsColorEngine';
            config.output.filename = 'jsColorEngineWeb.js';
            config.output.path = path.resolve(__dirname, './browser');
        }
    }
    return config;
};