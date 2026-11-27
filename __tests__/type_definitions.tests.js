/**
 * src/main.d.ts is written by hand, so nothing stops it drifting from the
 * code: a method renamed in Transform.js would leave a declaration behind
 * that type-checks and fails at runtime.
 *
 * This reads the declarations as text and checks that every method and static
 * they name exists on the running engine. It does not need the TypeScript
 * compiler, and it does not check argument or return types — only that what
 * is declared is there.
 */
const fs = require('fs');
const path = require('path');
const engine = require('../src/main');

const declarations = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.d.ts'), 'utf8')
    .replace(/\r\n/g, '\n');

/** The body of `class Name { ... }` or `interface Name { ... }`, by brace matching. */
function blockOf(keyword, name){
    const start = declarations.search(new RegExp('\\b' + keyword + ' ' + name + '\\b[^{]*\\{'));
    if(start < 0) throw new Error('no ' + keyword + ' ' + name + ' in main.d.ts');
    let position = declarations.indexOf('{', start);
    const bodyStart = position + 1;
    let depth = 0;
    for(; position < declarations.length; position++){
        if(declarations[position] === '{') depth++;
        else if(declarations[position] === '}' && --depth === 0) break;
    }
    return declarations.slice(bodyStart, position).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Names declared as methods, at the top level of a block. */
function methodsIn(block){
    const instanceMethods = [], staticMembers = [];
    let depth = 0;
    for(const line of block.split('\n')){
        if(depth === 0){
            const method = /^\s*(static\s+)?(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(<[^(]*)?\(/.exec(line);
            const staticProperty = /^\s*static\s+(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
            if(method && method[2] !== 'constructor') (method[1] ? staticMembers : instanceMethods).push(method[2]);
            else if(staticProperty) staticMembers.push(staticProperty[1]);
        }
        depth += (line.match(/[{(]/g) || []).length - (line.match(/[})]/g) || []).length;
    }
    return { instanceMethods, staticMembers };
}

describe('src/main.d.ts matches the running engine', () => {

    test('package.json points at the declarations', () => {
        const manifest = require('../package.json');
        expect(manifest.types).toBe('src/main.d.ts');
    });

    test.each(['Profile', 'Transform', 'Loader'])('%s: every declared method and static exists', (className) => {
        const { instanceMethods, staticMembers } = methodsIn(blockOf('class', className));
        expect(instanceMethods.length).toBeGreaterThan(3);

        const instance = className === 'Transform' ? new engine.Transform() : new engine[className]();
        const missing = [];
        for(const name of instanceMethods){
            if(typeof instance[name] !== 'function') missing.push(className + '#' + name + '()');
        }
        for(const name of staticMembers){
            if(!(name in engine[className])) missing.push(className + '.' + name);
        }
        expect(missing).toEqual([]);
    });

    test('color and convert: every declared helper exists, and none is left out', () => {
        const block = blockOf('interface', 'ColorHelpers');
        const { instanceMethods } = methodsIn(block);
        expect(instanceMethods.length).toBeGreaterThan(50);

        const missing = instanceMethods.filter(name => typeof engine.color[name] !== 'function');
        expect(missing).toEqual([]);

        const declared = new Set(instanceMethods);
        const undeclared = Object.keys(engine.color)
            .filter(name => typeof engine.color[name] === 'function' && !declared.has(name));
        expect(undeclared).toEqual([]);
        expect(engine.convert).toBe(engine.color);
    });

    test('the enums are declared with the values they have', () => {
        for(const enumName of ['eIntent', 'eColourType', 'eProfileType', 'encoding']){
            const block = blockOf('const', enumName);
            const declared = {};
            for(const match of block.matchAll(/readonly\s+([A-Za-z0-9_]+):\s*(\d+);/g)) declared[match[1]] = Number(match[2]);
            expect(declared).toEqual(engine[enumName]);
        }
    });

    test('alpha: the three helpers are declared and exist', () => {
        const block = blockOf('const', 'alpha');
        for(const name of ['unpremultiply', 'premultiply', 'flatten']){
            expect(block).toMatch(new RegExp('\\b' + name + '\\b'));
            expect(typeof engine.alpha[name]).toBe('function');
        }
        expect(Object.keys(engine.alpha).sort()).toEqual(['flatten', 'premultiply', 'unpremultiply']);
    });
});
