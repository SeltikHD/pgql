/* eslint-disable @typescript-eslint/ban-ts-comment */
import { type QueryResultRow, type PoolConfig, Pool, types } from 'pg';
import { replaceNull } from '../string';
import parseByteA from 'postgres-bytea';
import interval from 'postgres-interval';
import array from 'postgres-array';

export function defineParsers() {
    types.setTypeParser(1700, types.getTypeParser(700)); // Numeric to Double
    types.setTypeParser(20, types.getTypeParser(21)); // Big int to int
    types.setTypeParser(114, v => String(v)); // json to string
    types.setTypeParser(3802, v => String(v)); // jsonb to string

    // @ts-ignore
    types.setTypeParser(199, v => {
        if (!v) return null;

        return array.parse<string>(
            v,
            allowNull(entry => {
                return String(entry);
            }),
        );
    }); // json[] to string

    // @ts-ignore
    types.setTypeParser(3807, v => {
        if (!v) return null;

        return array.parse<string>(
            v,
            allowNull(entry => {
                return String(entry);
            }),
        );
    }); // jsonb[] to string

    function allowNull<T, K>(fn: (value: T) => K) {
        return (value: T) => {
            if (value === null) return null as K;
            return fn(value);
        };
    }

    types.setTypeParser(20, value => parseByteA(value).toString()); // Byte[] to string

    types.setTypeParser(1186, value => {
        const { years, months, days, hours, minutes, seconds, milliseconds, toISO, toISOString, toPostgres } =
            interval(value);

        return {
            years,
            months,
            days,
            hours,
            minutes,
            seconds,
            milliseconds,
            ISO: toISO(),
            ISOString: toISOString(),
            postgres: toPostgres(),
        };
    }); // Interval to obj

    // @ts-ignore
    types.setTypeParser(1016, value => {
        if (!value) return null;

        return array.parse<number>(
            value,
            allowNull(entry => {
                return (types.getTypeParser(21) as (value: string) => number)(entry.trim());
            }),
        );
    }); // Big int[] to int[]

    // @ts-ignore
    types.setTypeParser(1001, value => {
        if (!value) return null;

        return array.parse<string>(
            value,
            allowNull(entry => {
                return parseByteA(entry).toString();
            }),
        );
    }); // ByteA[] to string
}

const credentialsDefault = {
    user: process.env.PG_USER_main,
    host: process.env.PG_HOST_main,
    database: process.env.PG_DB_main,
    password: process.env.PG_PASSWORD_main,
    port: +(process.env.PG_PORT_main ?? 5432),
};

export async function execQuery<T extends QueryResultRow, P = any>(
    credentials: PoolConfig,
    query: string,
    values?: P[],
    exception?: boolean,
) {
    try {
        credentials = credentials ?? credentialsDefault;

        if (credentials.user && credentials.host && credentials.database && credentials.password) {
            defineParsers();
            const pool = new Pool(credentials);
            const data = await pool.query<T, P[]>(query, values);
            await pool.end();

            return {
                ...data,
                rows: (await Promise.all(data.rows)).map(
                    result => JSON.parse(JSON.stringify(result, replaceNull)) as T,
                ),
            };
        } else {
            return null;
        }
    } catch (e: any) {
        if (exception) {
            throw Error(e);
        }

        return null;
    }
}
