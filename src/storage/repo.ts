// The app's repository instance (browser only).
// IndexedDB in the browser: room for hundreds of analysed games, where localStorage holds ~5 MB
// (about 30–50 of them). Existing localStorage data is copied over once and left in place.
import { KvRepository, memoryStore, type CoachRepository } from './repository';
import { indexedDbStore } from './indexedDb';

export const repo: CoachRepository = new KvRepository(
  typeof indexedDB !== 'undefined' && typeof localStorage !== 'undefined' ? indexedDbStore(localStorage) : memoryStore(),
);
