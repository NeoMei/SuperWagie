import { readFile } from 'node:fs/promises';

type SqliteFixture = 'quoted' | 'unsafe' | 'rows' | 'wide' | 'plain' | 'invoice' | 'picker';

/** Static SQLite samples keep browser tests independent of a native SQLite binding. */
export const sqliteFixture = async (name: SqliteFixture) => new Uint8Array(await readFile(new URL(`./__fixtures__/${name}.sqlite`, import.meta.url)));
