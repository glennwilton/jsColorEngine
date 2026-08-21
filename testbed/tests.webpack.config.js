const path = require('path');

var config = {
    mode: 'development',
    entry: './speed_tests/tests.js',
    output: {
        hashFunction: "sha256",
        filename: 'colorEngineTests.js',
        path: path.resolve(__dirname, './dev'),
    },
    externalsPresets: {
        node: true,
    },
    externals:{
        fs:    "commonjs fs",
        path:  "commonjs path",
        http:  "commonjs http"
    }
}

module.exports = (env, argv) => {
    if (argv.mode === 'development') {
        config.devtool = 'source-map';
        config.output.path =path.resolve(__dirname, './dev')
    }

    if (argv.mode === 'production') {
        config.output.path =path.resolve(__dirname, './build')
    }

    return config;
};