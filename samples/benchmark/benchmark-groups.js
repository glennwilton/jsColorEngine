// benchmark-groups.js
//
// Groups bundle related benchmarks. Each group can have its own async loader
// that fetches engines/profiles only when the group is actually run.

export class BenchmarkGroup {
    constructor(config) {
        this.id           = config.id;
        this.name         = config.name;
        this.description  = config.description || '';
        this.tags         = config.tags         || [];
        this.dependencies = config.dependencies || [];
        this.loader       = config.loader;   // async (group) => { group.register(...) }
        this.benchmarks   = [];
        this.loaded       = false;
    }

    register(benchmark) {
        if (!benchmark.id || !benchmark.name) {
            throw new Error('Benchmark requires id and name');
        }
        if (typeof benchmark.setup !== 'function' || typeof benchmark.transform !== 'function') {
            throw new Error(`Benchmark "${benchmark.id}" requires setup() and transform()`);
        }
        this.benchmarks.push(benchmark);
    }

    async load() {
        if (this.loaded) return;
        if (this.loader) await this.loader(this);
        this.loaded = true;
    }

    getAll()        { return this.benchmarks.slice(); }
    getById(id)     { return this.benchmarks.find((b) => b.id === id); }
    getByTag(tag)   { return this.benchmarks.filter((b) => b.tags?.includes(tag)); }
}

export class GroupRegistry {
    constructor() {
        this.groups = new Map();
    }

    register(group) { this.groups.set(group.id, group); }
    get(id)         { return this.groups.get(id); }
    has(id)         { return this.groups.has(id); }
    list()          { return [...this.groups.values()]; }

    async loadGroup(id) {
        const group = this.groups.get(id);
        if (!group) throw new Error(`Group "${id}" not found`);
        for (const depId of group.dependencies) {
            await this.loadGroup(depId);
        }
        await group.load();
        return group;
    }
}

export const groups = new GroupRegistry();