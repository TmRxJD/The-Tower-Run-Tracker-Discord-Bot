// Read-only stage probe. Never loads production persistence or sends Discord messages.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('--help') || !args.includes('--user')) {
    console.log('Usage: node scripts/probe-history-latency.cjs --user DISCORD_ID [--runtime-root PATH] [--baseline PATH] [--candidate PATH] [--output PATH] [--main-only]');
    process.exit(args.includes('--help') ? 0 : 1);
}
const root = process.cwd();
const runtimeRoot = args.includes('--runtime-root') ? path.resolve(args[args.indexOf('--runtime-root') + 1]) : root;
const baselinePath = args.includes('--baseline') ? path.resolve(args[args.indexOf('--baseline') + 1]) : root + '/src/features/track/run-cloud-pair-client.ts';
const outputPath = args.includes('--output') ? path.resolve(args[args.indexOf('--output') + 1]) : null;
function report(value) { const line = JSON.stringify(value); console.log(line); if (outputPath) fs.appendFileSync(outputPath, line + '\n'); }
const user = args[args.indexOf('--user') + 1];
if (!/^\d{17,20}$/.test(user || ''))
    throw new Error('Expected a Discord user ID');
const candidatePath = args.includes('--candidate') ? path.resolve(args[args.indexOf('--candidate') + 1]) : root + '/src/features/track/run-cloud-pair-client.ts';
const deadline = setTimeout(() => { console.error('Read-only probe deadline exceeded'); process.exit(1); }, 120000);
deadline.unref();
const req = Module.createRequire(root + '/package.json');
req('dotenv').config({ path: runtimeRoot + '/.env.prod', quiet: true });
const { Client, Databases, Users, Query } = req('node-appwrite');
const ts = req('typescript');
const client = new Client().setEndpoint(process.env.APPWRITE_ENDPOINT).setProject(process.env.APPWRITE_PROJECT_ID).setKey(process.env.APPWRITE_API_KEY);
const db = new Databases(client);
let samples = [];
let active = 0, maxActive = 0;
const readDb = { listDocuments: async (...args) => { const queries = args[2].map(JSON.parse); const stage = args[1] === 'runs_extended_data' ? 'extended' : queries.some(q => q.method === 'select') ? 'count' : 'main'; const t = performance.now(); active++; maxActive = Math.max(active, maxActive); try {
        const result = await db.listDocuments(...args);
        samples.push({ stage, ms: Math.round(performance.now() - t), rows: result.documents.length, total: result.total, maxQueryChars: Math.max(...args[2].map(q => q.length)) });
        return result;
    }
    finally {
        active--;
    } } };
function load(file) { const filename = root + '/dist/features/track/run-cloud-pair-client.js'; const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText; const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename)); const original = Module._load; Module._load = function (name, parent, ...rest) { if (parent === mod) {
    if (name === '../../persistence/appwrite-client')
        return { createAppwriteClient: () => ({ databases: readDb }) };
    if (name === './run-cloud-identity')
        return { resolveBotRunCloudIdentity: async () => ({ lookupUserIds: owners }) };
    if (name === '../../rxdb/local-only-backup')
        return {};
} return original.call(this, name, parent, ...rest); }; try {
    mod._compile(code, filename);
}
finally {
    Module._load = original;
} return mod.exports.loadBotCompleteRunCloudDocuments; }
function stable(x) { if (Array.isArray(x))
    return x.map(stable); if (x && typeof x === 'object')
    return Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])); return x; }
let owners;
(async () => {
    const discord = user;
    let t = performance.now();
    const ids = await new Users(client).listIdentities([Query.equal('provider', 'discord'), Query.equal('providerUid', discord)]);
    const linked = ids.identities.find(x => x.provider === 'discord' && x.providerUid === discord)?.userId;
    owners = [...new Set([linked, discord].filter(Boolean))];
    report({ identityMs: Math.round(performance.now() - t), ownerCount: owners.length });
    const baseline = load(baselinePath);
    const candidate = load(candidatePath);
    let previous;
    for (const [name, fn] of [['baseline', baseline], ['candidate', candidate], ['baseline-repeat', baseline], ['candidate-repeat', candidate]]) {
        samples = [];
        maxActive = 0;
        t = performance.now();
        const cpuStarted = process.cpuUsage();
        const rows = await fn(discord, { includeExtended: !args.includes('--main-only') });
        const hash = crypto.createHash('sha256').update(JSON.stringify(stable(rows.sort((a, b) => String(a.$id).localeCompare(String(b.$id)))))).digest('hex');
        const cpu = process.cpuUsage(cpuStarted);
        report({ name, ms: Math.round(performance.now() - t), processCpuMs: Math.round((cpu.user + cpu.system) / 1000), rows: rows.length, fieldEquality: previous ? previous === hash : null, requests: samples.length, maxActive, stages: samples });
        if (previous && previous !== hash)
            throw new Error('History changed or field comparison failed');
        previous = hash;
    }
})().catch(e => { console.error('Read-only probe failed:', e.name, e.code || ''); process.exitCode = 1; });
