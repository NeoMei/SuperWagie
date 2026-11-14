/** The browser-only SQL.js operations used by the read-only data preview worker. */
declare module 'sql.js/dist/sql-wasm-browser.js' {
  export type SqlValue = string | number | bigint | Uint8Array | null;
  export type QueryResult = { columns: string[]; values: SqlValue[][] };
  export type Statement = {
    step(): boolean;
    get(params: null, config: { useBigInt: boolean }): SqlValue[];
    getColumnNames(): string[];
    free(): void;
  };
  export type Database = {
    exec(query: string): QueryResult[];
    run(query: string): void;
    prepare(query: string, params?: SqlValue[]): Statement;
    close(): void;
  };
  export default function initSqlJs(config: { wasmBinary: Uint8Array }): Promise<{ Database: new (data: Uint8Array) => Database }>;
}
