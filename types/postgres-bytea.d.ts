declare module 'postgres-bytea' {
    function parseBytea(input: string): Buffer;
    export = parseBytea;
}
