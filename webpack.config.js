const path = require('path');

var config = {
    mode: 'development',
    entry: './src/main.js',
    output: {
        hashFunction: "sha256",
        filename: 'jsColorEngine.js',
        path: path.resolve(__dirname, './package'),
        libraryTarget: 'umd'
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