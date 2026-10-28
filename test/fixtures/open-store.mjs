// Opens a Store on the path given, as a separate process would (mcpspy run, ui, tail…).
// Run with `node --import tsx`; exits 0 once the store is open and migrated.
const { Store } = await import('../../src/store.ts');
const store = new Store(process.argv[2]);
store.createSession({ name: 'child', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: Date.now() });
store.close();
