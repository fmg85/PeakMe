// Installs an in-memory IndexedDB (indexedDB, IDBKeyRange, …) on globalThis so the
// offline persistence layer (idb) runs in tests. Individual tests assign a fresh
// `new IDBFactory()` in beforeEach for isolation.
import 'fake-indexeddb/auto'
