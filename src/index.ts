import type {
    InputDefinitionBlock,
    NexusEnumTypeDef,
    NexusInputObjectTypeDef,
    NexusObjectTypeDef,
    ObjectDefinitionBlock,
} from 'nexus/dist/core';
import type { ClientConfig, QueryResultRow } from 'pg';
import { enumType, objectType, queryType, mutationType, intArg, nonNull, inputObjectType, arg, list } from 'nexus';
import { pascalCaseToSnakeCase, toCamelCase, toNameCase, toPascalCase } from './utils/string';
import { getType, pgTypesToGraphQLCustomObjects } from './utils/db/pgTypesToGraphql';
import { mergeObjectsWithSameName, removeDuplicates } from './utils/filters';
import { execQuery } from './utils/db/execQuery';

export type Operations = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE';

export type Schema = { name: string; tables: Table[]; views?: Table[] };
export type Table = {
    name: string;
    description?: string;
    columns: Column[];
    operations: Operations[];
    type: 'table' | 'view';
    variables?: Variable[];
    defaultWhere?: string;
    cols?: string[];
};

export type Column = {
    name: string;
    description?: string;
    type: string;
    oid: number;
    nullable: boolean;
    isPrimaryKey: boolean;
    foreignKey: {
        is: boolean;
        data?: {
            nexusObjectName?: string;
            referencedSchema: string;
            referencedTable: string;
            referencedColumn: string;
        };
    };
};

export type VariableType = 'string' | 'int' | 'float' | 'boolean';

export type Variable = {
    name: string;
    type: VariableType;
    description?: string;
    nullable: boolean;
};

export type TableFilter = Omit<Table, 'description' | 'columns' | 'type'>;

export type SchemaOptions = {
    name: string;
    tables: TableFilter[];
    views?: TableFilter[];
};

export interface GenerateDBSchemaOptions {
    schemas?: SchemaOptions[];
    generateForeignTables?: boolean;
}

/**
 * Generates an array of objects that will be used to create Nexus objects in GraphQL.
 * @param credentials - The client credentials for the PostgreSQL connection.
 * @param options - Additional options for generating the database schema.
 * @returns A promise that resolves to an array of schemas.
 */
export const generateDBSchema = async (
    credentials: ClientConfig,
    options?: GenerateDBSchemaOptions,
): Promise<Schema[]> => {
    /**
     * Retrieves the schema filter with the specified name from the given schemas.
     * @param name - The name of the schema.
     * @param schemas - The array of schema options.
     * @returns The schema filter with the specified name, or undefined if not found.
     */
    const getSchemaFilter = (name: string, schemas?: SchemaOptions[]) => schemas?.find(sc => sc.name === name);

    /**
     * Retrieves the table filter with the specified schema name and table name from the given schemas.
     * @param schemaName - The name of the schema.
     * @param tableName - The name of the table.
     * @param schemas - The array of schema options.
     * @returns The table filter with the specified schema name and table name, or undefined if not found.
     */
    const getTablesFilter = (schemaName: string, tableName: string, schemas?: SchemaOptions[]) =>
        getSchemaFilter(schemaName, schemas)?.tables.filter(t => t.name === tableName);

    /**
     * Retrieves the view filter with the specified schema name and view name from the given schemas.
     * @param schemaName - The name of the schema.
     * @param viewName - The name of the view.
     * @param schemas - The array of schema options.
     * @returns The view filter with the specified schema name and view name, or undefined if not found.
     */
    const getViewFilter = (schemaName: string, viewName: string, schemas?: SchemaOptions[]) =>
        getSchemaFilter(schemaName, schemas)?.views?.find(v => v.name === viewName);

    /**
     * Constructs the WHERE clause for the schema filters.
     * @param schemas - The array of schema options.
     * @returns The WHERE clause for the schema filters.
     */
    const makeSchemasWhere = (schemas?: SchemaOptions[]) =>
        schemas ? `WHERE ${schemas.map(sc => `nspname = '${sc.name}'`).join(' OR ')}` : '';

    /**
     * Constructs the regular expression SQL for matching table or view names.
     * @param colName - The column name to match against.
     * @param name - The name to match.
     * @returns The regular expression SQL for matching table or view names.
     */
    const makeRegexSQLTableOrViewName = (colName: string, name: string) => `
        regexp_matches(${colName}, 
            ('^' || 
                regexp_replace(
                    regexp_replace(
                        regexp_replace(
                            '${name}', '([\\\\-\\\\[\\\\]\\\\/\\\\{\\\\}\\\\(\\\\)\\\\+\\\\?\\\\.\\\\\\\\\\\\^\\\\$\\\\|])', '\\\\\\\\$&', 'g'
                        ), '[*]', '.*', 'g'
                    ), '[?]', '.{1}', 'g'
                ) || '$'
            )
        )`;

    /**
     * Constructs the WHERE clause for the table filters.
     * @param schemaName - The name of the schema.
     * @param schemas - The array of schema options.
     * @returns The WHERE clause for the table filters.
     */
    const makeTablesWhere = (schemaName: string, schemas?: SchemaOptions[]) => {
        const sFilter = getSchemaFilter(schemaName, schemas);

        return sFilter
            ? `
            AND (
                ${sFilter.tables
                    .map(
                        t => `
                        (SELECT
                            count(*)
                        FROM
                            ${makeRegexSQLTableOrViewName('tablename', t.name)}
                        ) > 0`,
                    )
                    .join(' OR ')})`
            : '';
    };

    /**
     * Constructs the WHERE clause for the view filters.
     * @param schemaName - The name of the schema.
     * @param schemas - The array of schema options.
     * @returns The WHERE clause for the view filters.
     */
    const makeViewsWhere = (schemaName: string, schemas?: SchemaOptions[]) => {
        const sFilter = getSchemaFilter(schemaName, schemas);

        return sFilter?.views
            ? `
            AND (
                ${sFilter.views
                    .map(
                        v => `
                        (SELECT
                            count(*)
                        FROM
                            ${makeRegexSQLTableOrViewName('viewname', v.name)}
                        ) > 0`,
                    )
                    .join(' OR ')})`
            : 'AND 1 = 0';
    };

    /**
     * Generates the schema for the specified schemas.
     * @param schemas - The array of schema options.
     * @returns A promise that resolves to an array of schemas.
     */
    const genSchema = async (schemas?: SchemaOptions[]) =>
        Promise.all(
            await execQuery<{
                name: string;
            }>(credentials, `SELECT nspname as name FROM pg_namespace ${makeSchemasWhere(schemas)}`)
                .then(r => r?.rows ?? [])
                .then(sc =>
                    sc.map(
                        async s =>
                            ({
                                ...s,
                                tables: await Promise.all(
                                    await execQuery<{ name: string; description?: string; type: 'table' | 'view' }>(
                                        credentials,
                                        `SELECT
                                            tablename AS name,
                                            obj_description(('"' || schemaname || '"."' || tablename || '"')::regclass) AS description,
                                            'table' AS type
                                        FROM
                                            pg_tables
                                        WHERE
                                            schemaname = $1
                                            ${makeTablesWhere(s.name, schemas)}
                                        UNION ALL
                                        SELECT
                                            viewname AS name,
                                            obj_description(('"' || schemaname || '"."' || viewname || '"')::regclass) AS description,
                                            'view' AS type
                                        FROM
                                            pg_views
                                        WHERE
                                            schemaname = $1
                                            ${makeViewsWhere(s.name, schemas)}`,
                                        [s.name],
                                    )
                                        .then(t => t?.rows ?? [])
                                        .then(ta =>
                                            ta.flatMap(async t => {
                                                if (t.type == 'table') {
                                                    const primariesKeys = await execQuery<{ column_name: string }>(
                                                        credentials,
                                                        `SELECT
                                                            column_name
                                                        FROM
                                                            information_schema.key_column_usage
                                                        WHERE
                                                            table_schema = $1
                                                            AND table_name = $2
                                                            AND constraint_name = (
                                                                SELECT
                                                                    constraint_name
                                                                FROM
                                                                    information_schema.table_constraints
                                                                WHERE
                                                                    table_schema = $1
                                                                    AND table_name = $2
                                                                    AND constraint_type = 'PRIMARY KEY'
                                                                LIMIT 1
                                                            )`,
                                                        [s.name, t.name],
                                                    )
                                                        .then(r => r?.rows ?? [])
                                                        .then(r => r.map(rr => rr.column_name));

                                                    const foreignKeys = await execQuery<{
                                                        referencing_column: string;
                                                        referenced_schema: string;
                                                        referenced_table: string;
                                                        referenced_column: string;
                                                    }>(
                                                        credentials,
                                                        `SELECT
                                                            att.attname AS referencing_column,
                                                            nsp2.nspname AS referenced_schema,
                                                            cl2.relname AS referenced_table,
                                                            att2.attname AS referenced_column
                                                        FROM
                                                            pg_constraint con
                                                        JOIN 
                                                            pg_class cl ON
                                                            cl.oid = con.conrelid
                                                        JOIN 
                                                            pg_namespace nsp ON
                                                            nsp.oid = cl.relnamespace
                                                        JOIN 
                                                            pg_attribute att ON
                                                            att.attrelid = con.conrelid
                                                            AND att.attnum = con.conkey[1]
                                                        JOIN 
                                                            pg_class cl2 ON
                                                            cl2.oid = con.confrelid
                                                        JOIN 
                                                            pg_namespace nsp2 ON
                                                            nsp2.oid = cl2.relnamespace
                                                        JOIN 
                                                            pg_attribute att2 ON
                                                            att2.attrelid = con.confrelid
                                                            AND att2.attnum = con.confkey[1]
                                                        WHERE
                                                            con.contype = 'f'
                                                            AND nsp.nspname = $1
                                                            AND cl.relname = $2`,
                                                        [s.name, t.name],
                                                    ).then(r => r?.rows ?? []);

                                                    const columns = await execQuery<{
                                                        name: string;
                                                        type: string;
                                                        oid: number;
                                                        nullable: 'YES' | 'NO';
                                                        description?: string;
                                                    }>(
                                                        credentials,
                                                        `SELECT
                                                            c.column_name AS "name",
                                                            c.udt_name AS "type",
                                                            t.oid AS "oid",	
                                                            c.is_nullable AS "nullable",
                                                            col_description(($1 || '.' || $2)::regclass, c.ordinal_position) AS description
                                                        FROM
                                                            information_schema.columns c
                                                        JOIN pg_type t 
                                                        ON t.typname = c.udt_name  
                                                        WHERE
                                                            table_schema = $1
                                                            AND table_name = $2`,
                                                        [s.name, t.name],
                                                    )
                                                        .then(t => t?.rows ?? [])
                                                        .then(
                                                            r =>
                                                                r.map(row => {
                                                                    const foreignKey = foreignKeys.find(
                                                                        fk => fk.referencing_column === row.name,
                                                                    );

                                                                    return {
                                                                        ...row,
                                                                        nullable: row.nullable === 'YES',
                                                                        isPrimaryKey: primariesKeys.includes(row.name),
                                                                        foreignKey: {
                                                                            is: foreignKey != undefined,
                                                                            data: foreignKey
                                                                                ? {
                                                                                      referencedSchema:
                                                                                          foreignKey.referenced_schema,
                                                                                      referencedTable:
                                                                                          foreignKey.referenced_table,
                                                                                      referencedColumn:
                                                                                          foreignKey.referenced_column,
                                                                                  }
                                                                                : undefined,
                                                                        },
                                                                    };
                                                                }) as Column[],
                                                        );

                                                    const tablesFilter = getTablesFilter(s.name, t.name, schemas);

                                                    return (
                                                        tablesFilter?.map(
                                                            tableFilter =>
                                                                ({
                                                                    ...t,
                                                                    operations: tableFilter?.operations ?? [],
                                                                    defaultWhere: tableFilter?.defaultWhere,
                                                                    columns,
                                                                    cols: columns
                                                                        .map(c => c.name)
                                                                        .filter(c =>
                                                                            tableFilter &&
                                                                            Array.isArray(tableFilter.cols) &&
                                                                            (tableFilter.cols?.length ?? 0) > 0
                                                                                ? tableFilter.cols.includes(c)
                                                                                : true,
                                                                        ),
                                                                }) as Table,
                                                        ) ?? []
                                                    );
                                                } else if (t.type == 'view') {
                                                    return {
                                                        ...t,
                                                        operations:
                                                            getViewFilter(s.name, t.name, schemas)?.operations ?? [],
                                                        columns: await execQuery<{
                                                            name: string;
                                                            type: string;
                                                            oid: number;
                                                            nullable: 'YES' | 'NO';
                                                            description?: string;
                                                        }>(
                                                            credentials,
                                                            `SELECT
                                                                c.column_name AS "name",
                                                                c.udt_name AS "type",
                                                                t.oid AS "oid",	
                                                                c.is_nullable AS "nullable",
                                                                col_description(($1 || '.' || $2)::regclass, c.ordinal_position) AS description
                                                            FROM
                                                                information_schema.columns c
                                                            JOIN pg_type t 
                                                            ON t.typname = c.udt_name  
                                                            WHERE
                                                                table_schema = $1
                                                                AND table_name = $2`,
                                                            [s.name, t.name],
                                                        )
                                                            .then(t => t?.rows ?? [])
                                                            .then(
                                                                r =>
                                                                    r.map(row => ({
                                                                        ...row,
                                                                        nullable: row.nullable === 'YES',
                                                                        isPrimaryKey: false,
                                                                        foreignKey: {
                                                                            is: false,
                                                                        },
                                                                    })) as Column[],
                                                            ),
                                                    } as Table;
                                                }
                                            }),
                                        ),
                                ).then(t => t.flat(2)),
                            }) as Schema,
                    ),
                ),
        );

    const schema = removeDuplicates(
        await genSchema(
            mergeObjectsWithSameName(
                options?.schemas
                    ? options.schemas.map(sc => ({
                          ...sc,
                          tables: sc.tables.flat(2),
                          views: sc.views ? mergeObjectsWithSameName(sc.views, 'name') : sc.views,
                      }))
                    : [],
                'name',
            ),
        ),
    );

    if (options?.generateForeignTables) {
        let schemas: SchemaOptions[] = [];

        schema.forEach(s =>
            s.tables
                .filter(t => t.type == 'table')
                .forEach(t =>
                    t.columns.forEach(async c => {
                        const {
                            foreignKey: { is, data },
                        } = c;

                        const schemaForeign = schema.find(sc => sc.name === data?.referencedSchema);
                        const exists = schemaForeign
                            ? schemaForeign.tables.find(tb => tb.name === data?.referencedTable) != undefined
                            : false;

                        if (is && data !== undefined && !exists) {
                            const { referencedSchema, referencedTable } = data;

                            const schema = schemas.find(sc => sc.name == referencedSchema);

                            if (schema) {
                                schemas = [
                                    ...schemas.filter(sc => sc.name != referencedSchema),
                                    {
                                        ...schema,
                                        tables: [...schema.tables, { name: referencedTable, operations: [] }],
                                    },
                                ];
                            } else {
                                schemas.push({
                                    name: referencedSchema,
                                    tables: [{ name: referencedTable, operations: [] }],
                                });
                            }
                        }
                    }),
                ),
        );

        if (schemas.length > 0) {
            const dbSchemaLinked = await genSchema(schemas);

            const unifiedSchemas: Schema[] = [];

            [...schema, ...dbSchemaLinked].forEach(sc => {
                const index = unifiedSchemas.findIndex(i => i.name === sc.name);

                if (index === -1) {
                    unifiedSchemas.push(sc);
                } else {
                    unifiedSchemas[index].tables.push(...sc.tables);
                }
            });

            return removeDuplicates(unifiedSchemas);
        }
    }

    return schema;
};

type SingleConditions =
    | 'EQUAL'
    | 'NOT_EQUAL'
    | 'LESS_THAN'
    | 'LESS_THAN_OR_EQUAL'
    | 'GREATER_THAN'
    | 'GREATER_THAN_OR_EQUAL'
    | 'LIKE'
    | 'ILIKE'
    | 'NOT_LIKE'
    | 'NOT_ILIKE'
    | 'IS_NULL'
    | 'IS_NOT_NULL';

type ArrayConditions = 'BETWEEN' | 'NOT_BETWEEN' | 'IN' | 'NOT_IN';

type SingleCondition = { condition: SingleConditions; value?: any };
type ArrayCondition = { condition: ArrayConditions; value: any[] };

interface ANDType {
    [x: string]: [ANDType] | [ORType] | { SINGLE?: SingleCondition; ARRAY?: ArrayCondition };
}

interface ORType {
    [x: string]: [ANDType] | [ORType] | { SINGLE?: SingleCondition; ARRAY?: ArrayCondition };
}

interface WhereType {
    AND?: [ANDType];
    OR?: [ORType];
}

interface OrderByType {
    [x: string]: 'ASC' | 'DESC';
}

const nullableOperators: Array<keyof typeof operators> = ['IS_NULL', 'IS_NOT_NULL'];

const operators = {
    EQUAL: '=',
    NOT_EQUAL: '<>',
    LESS_THAN: '<',
    LESS_THAN_OR_EQUAL: '<=',
    GREATER_THAN: '>',
    GREATER_THAN_OR_EQUAL: '>=',
    LIKE: 'LIKE',
    ILIKE: 'ILIKE',
    NOT_LIKE: 'NOT LIKE',
    NOT_ILIKE: 'NOT ILIKE',
    BETWEEN: 'BETWEEN',
    NOT_BETWEEN: 'NOT BETWEEN',
    IN: 'IN',
    NOT_IN: 'NOT IN',
    IS_NULL: 'IS NULL',
    IS_NOT_NULL: 'IS NOT NULL',
};

/**
 * Generates the WHERE clause of an SQL query based on the provided conditions.
 *
 * @param {WhereType} where - The conditions for the WHERE clause.
 * @param {string[]} values - An array to store the parameter values.
 * @param {Table} table - The table object containing column information.
 * @param {number} [startVarIndex] - The starting index for parameter values.
 * @returns {string} The generated WHERE clause.
 */
const whereSQL = (where: WhereType, values: string[], table: Table, startVarIndex?: number): string => {
    type ANDOrOR = {
        col: Column;
        condition: { SINGLE?: SingleCondition; ARRAY?: ArrayCondition };
    };

    const mapCondition = (c: SingleCondition | ArrayCondition, type: string) => {
        const condition = c.condition;
        const v = c.value;

        if (Array.isArray(v)) {
            const initIndex = values.length;
            const finalIndex = initIndex + v.length;

            v.forEach((vv, i) => {
                values[initIndex + i] = String(vv);
            });

            const finalValues = values.slice(initIndex, finalIndex);

            return `${operators[condition]} (${finalValues.map((_, i) => '$' + (i + 1)).join(`::${type}, `)}::${type})`;
        } else {
            if (v !== undefined) {
                values.push(String(v));
            }

            const index = values.length + (startVarIndex ?? 0);
            return `${operators[condition]}${v !== undefined ? ` $${index}::${type}` : ''}`;
        }
    };

    const mapWhere = (v: ANDType | ORType, type: 'AND' | 'OR') => {
        const keys = Object.keys(v);

        const conditions: ANDOrOR[] = [];
        let subAND, subOR;

        keys.forEach(k => {
            const col = table.columns.find(c => c.name == k);

            if (['AND', 'OR'].includes(k)) {
                const key = k as 'AND' | 'OR';
                const va = v[key] as [ANDType | ORType];

                const c = va.map(v => mapWhere(v, key)).join(` ${type} `);

                if (key == 'AND') {
                    subAND = c;
                } else {
                    subOR = c;
                }
            } else if (col) {
                const data = v[k] as { SINGLE?: SingleCondition; ARRAY?: ArrayCondition };
                const d = data.SINGLE ?? data.ARRAY;

                if (d?.condition && (d?.value !== undefined || nullableOperators.includes(d.condition))) {
                    conditions.push({ col, condition: data });
                }
            }
        });

        return [
            ...conditions.map(({ col: { name, type }, condition: { SINGLE, ARRAY } }) =>
                SINGLE != undefined || ARRAY != undefined
                    ? `${name} ${mapCondition((SINGLE ?? ARRAY) as SingleCondition | ArrayCondition, type)}`
                    : '1 = 1',
            ),
            subAND ? `(${subAND})` : undefined,
            subOR ? `(${subOR})` : undefined,
        ]
            .filter(v => Boolean(v))
            .join(` ${type} `);
    };

    const AND = where.AND ? where.AND.map(a => mapWhere(a, 'AND')) : null;
    const OR = where.OR ? where.OR.map(o => mapWhere(o, 'OR')) : null;

    if (table.defaultWhere && table.variables) {
        table.variables.forEach((v, i) => {
            const index = i + (startVarIndex ?? 0);
            table.defaultWhere = table.defaultWhere?.replace(`$${v.name}`, `$${index}`);
        });
    }

    return (
        `WHERE ${table.defaultWhere ? `(${table.defaultWhere}) = TRUE AND ` : ''}` +
        [AND?.join(' AND '), OR?.join(' OR ')].filter(c => c != null).join(' AND ')
    );
};

/**
 * Represents the value types for mutation operations.
 */
type MutationValuesType = string | number | boolean | null;

/**
 * Represents the return type for mutation Create operations.
 */
type MutationCreateReturn = {
    query: string;
    values: MutationValuesType[];
};

/**
 * Generates the SQL query for creating a new record.
 *
 * @param {Omit<Schema, 'tables'>} schema - The schema object.
 * @param {Table} table - The table object.
 * @param {{ [x: string]: MutationValuesType }[]} [values] - An array of objects representing the record values.
 * @param {{ [x: string]: MutationValuesType }[]} [variables] - Custom variables for the WHERE clause.
 * @returns {MutationCreateReturn} The query and values for the mutation operation.
 */
function makeMutationCreate(
    schema: Omit<Schema, 'tables'>,
    table: Table,
    values: [{ [x: string]: MutationValuesType }],
    variables?: [{ [x: string]: MutationValuesType }],
): MutationCreateReturn {
    const { columns, cols, name, variables: vars } = table;

    vars
        ?.filter(v => !v.nullable && table.defaultWhere)
        .forEach(v => {
            variables?.forEach(va => {
                if (!va[v.name]) {
                    throw new Error(`Variable ${v.name} is required`);
                }
            });
        });

    const keys = columns
        .filter(c => (Array.isArray(cols) && cols.length > 0 ? !c.nullable || cols.includes(c.name) : true))
        .map(c => c.name);

    const finalValues = values.map(v => keys.map(k => v[k] ?? null));

    variables?.forEach((v, i) => {
        finalValues.push(v as any);
        table.defaultWhere = table.defaultWhere?.replace(`$${v.name}`, String(finalValues.length - i));
    });

    const stringValues = table.defaultWhere
        ? `SELECT ${finalValues
              .slice(0, finalValues.length - (vars?.length ?? 0))
              .map((v, multiplier) => `${v.map((_, i) => `$${keys.length * multiplier + (i + 1)}`).join(', ')}`)
              .join(', ')} WHERE (${table.defaultWhere})`
        : 'VALUES ' +
          finalValues
              .map((v, multiplier) => `(${v.map((_, i) => `$${keys.length * multiplier + (i + 1)}`).join(', ')})`)
              .join(', ');
    const query = `INSERT INTO ${schema.name}.${name}(${keys.join(', ')}) ${stringValues} RETURNING *`;

    return {
        query,
        values: finalValues.flat(),
    };
}

/**
 * Represents the return type for mutation Update operations.
 */
type MutationUpdateReturn = {
    query: string;
    whereQuery: string;
    values: MutationValuesType[];
};

/**
 * Generates the SQL query for updating existing records.
 *
 * @param {Omit<Schema, 'tables'>} schema - The schema object.
 * @param {Table} table - The table object.
 * @param {{ [x: string]: MutationValuesType }} value - An object representing the updated values.
 * @param {WhereType} where - The conditions for the UPDATE operation.
 * @returns {MutationUpdateReturn} The query, where clause, and values for the mutation operation.
 */
function makeMutationUpdate(
    schema: Omit<Schema, 'tables'>,
    table: Table,
    value: { [x: string]: MutationValuesType },
    where: WhereType,
): MutationUpdateReturn {
    const cols = table.cols;
    const keys = Object.keys(value)
        .map(v => ((cols ?? table.columns.map(c => c.name)).includes(v) ? v : null))
        .filter(v => Boolean(v)) as string[];

    const values: MutationValuesType[] = [];

    const updateValues = keys.map(k => value[k] ?? null);

    const whereQuery = where.AND || where.OR ? whereSQL(where, values as any, table) : 'WHERE TRUE IS FALSE';

    values.push(...updateValues);

    const query = `UPDATE ${schema.name}.${table.name} SET (${keys.join(', ')}) = (${updateValues
        .map((_, i) => `$${values.length - updateValues.length + i + 1}`)
        .join(', ')}) ${whereQuery} RETURNING *`;

    return {
        query,
        whereQuery,
        values,
    };
}

/**
 * Represents the return type for mutation Delete operations.
 */
type MutationDeleteReturn = {
    query: string;
    whereQuery: string;
    values: MutationValuesType[];
};

/**
 * Generates the SQL query for deleting records.
 *
 * @param {Omit<Schema, 'tables'>} schema - The schema object.
 * @param {Table} table - The table object.
 * @param {WhereType} where - The conditions for the DELETE operation.
 * @returns {MutationDeleteReturn} The query, where clause, and values for the mutation operation.
 */
function makeMutationDelete(schema: Omit<Schema, 'tables'>, table: Table, where: WhereType): MutationDeleteReturn {
    const values: MutationValuesType[] = [];

    const whereQuery = where.AND || where.OR ? whereSQL(where, values as any, table) : 'WHERE TRUE IS FALSE';

    const query = `DELETE FROM ${schema.name}.${table.name} ${whereQuery} RETURNING *`;

    return {
        query,
        whereQuery,
        values,
    };
}

/**
 * Represents the return type for query operations.
 */
type QueryReturn = {
    query: string;
    values: string[];
    orderByQuery: string | undefined;
    whereQuery: string | undefined;
};

/**
 * Represents the custom variable type.
 */
type VariableTypeObject = {
    [x: string]: string | number | boolean | null;
};

/**
 * Generates the SQL query for selecting records.
 *
 * @param {Omit<Schema, 'tables'>} schema - The schema object.
 * @param {Table} table - The table object.
 * @param {number} limit - The maximum number of records to retrieve.
 * @param {number} offset - The number of records to skip.
 * @param {WhereType} [where] - The conditions for the SELECT operation.
 * @param {VariableTypeObject} [variables] - Custom variables for the WHERE clause.
 * @param {OrderByType} [orderBy] - The sorting criteria for the records.
 * @param {string[]} [cols] - The columns to include in the SELECT statement.
 * @returns {QueryReturn} The query, values, orderBy clause, and where clause for the SELECT operation.
 */
function makeQuery(
    schema: Omit<Schema, 'tables'>,
    table: Table,
    limit: number,
    offset: number,
    where?: WhereType,
    variables?: VariableTypeObject,
    orderBy?: OrderByType,
    cols?: string[],
): QueryReturn {
    const colsSQL =
        cols && cols.length > 0 && cols.every(c => table.columns.find(cc => cc.name == c) != undefined)
            ? cols.join(', ')
            : '*';

    const requiredVariables = table.variables?.filter(v => !v.nullable && table.defaultWhere).map(v => v.name) ?? [];
    if (!Object.keys(variables ?? {}).every(v => requiredVariables.includes(v))) {
        throw new Error(`One required variable is missing. Required variables: ${requiredVariables.join(', ')}`);
    }

    const values: string[] = [
        ...Object.values(variables ?? {})
            .filter(Boolean)
            .map(v => String(v)),
    ];

    if (values.length < (table.variables?.length ?? 0)) {
        const diff = (table.variables?.length ?? 0) - values.length;
        values.push(...Array(diff).fill(null));
    }

    const orderBySQL = (orderBy: OrderByType) => {
        const keys = Object.keys(orderBy);

        if (keys.length <= 0 || !keys.every(k => orderBy[k] === 'ASC' || orderBy[k] === 'DESC')) {
            return '';
        }

        return 'ORDER BY ' + keys.map(k => k + ' ' + orderBy[k]).join(', ');
    };

    const orderByQuery = orderBy ? orderBySQL(orderBy) : '';
    const whereQuery =
        where?.AND || where?.OR
            ? whereSQL(where, values, table)
            : `WHERE ${table.defaultWhere ? `(${table.defaultWhere}) = TRUE` : 'TRUE = TRUE'}`;

    values.push(String(limit), String(offset));

    const query = `SELECT ${colsSQL} FROM ${schema.name}.${table.name} ${whereQuery} ${orderByQuery} LIMIT $${
        values.length - 1
    }::integer OFFSET $${values.length}::integer`;

    return {
        query,
        values,
        orderByQuery: orderByQuery.length < 1 ? undefined : orderByQuery,
        whereQuery: whereQuery.length < 1 ? undefined : whereQuery,
    };
}

/**
 * Generates the SQL query for retrieving pagination information.
 *
 * @param {string} schemaName - The name of the schema.
 * @param {string} tableName - The name of the table.
 * @param {{ sql: string; finalIndex: number }} [where] - The WHERE clause of the query.
 * @returns {string} The query for retrieving pagination information.
 */
function getPagesQuery(schemaName: string, tableName: string, where?: { sql: string; finalIndex: number }): string {
    return `SELECT (count(*) / $${
        where?.finalIndex ?? 1
    }) as pages, count(*) as total_rows FROM ${schemaName}.${tableName} ${where?.sql ?? ''}`;
}

/**
 * Options for generating the schema.
 */
export interface GenerateSchemaOptions {
    linkForeignKeysToTables: boolean;
    generateForeignTables: boolean;
}

/**
 * Default options for generating the schema.
 */
const defaultGenerateSchemaOptions: GenerateSchemaOptions = {
    linkForeignKeysToTables: true,
    generateForeignTables: false,
};

/**
 * Represents a Postgres to Nexus object mapping.
 */
interface PgToNexusObject {
    name: string;
    table: Table;
    schema: Omit<Schema, 'tables'>;
}

/**
 * Operators for different data types in PostgreSQL.
 */
const operatorsByType = {
    STRING: {
        SINGLE: {
            LIKE: 'LIKE',
            ILIKE: 'ILIKE',
            NOT_LIKE: 'NOT LIKE',
            NOT_ILIKE: 'NOT ILIKE',

            EQUAL: '=',
            NOT_EQUAL: '<>',
            IS_NULL: 'IS NULL',
            IS_NOT_NULL: 'IS NOT NULL',
        },
        ARRAY: {
            BETWEEN: 'BETWEEN',
            NOT_BETWEEN: 'NOT BETWEEN',
            IN: 'IN',
            NOT_IN: 'NOT IN',
        },
    },
    INT: {
        SINGLE: {
            LESS_THAN: '<',
            LESS_THAN_OR_EQUAL: '<=',
            GREATER_THAN: '>',
            GREATER_THAN_OR_EQUAL: '>=',

            EQUAL: '=',
            NOT_EQUAL: '<>',
            IS_NULL: 'IS NULL',
            IS_NOT_NULL: 'IS NOT NULL',
        },
        ARRAY: {
            BETWEEN: 'BETWEEN',
            NOT_BETWEEN: 'NOT BETWEEN',
            IN: 'IN',
            NOT_IN: 'NOT IN',
        },
    },
    FLOAT: {
        SINGLE: {
            LESS_THAN: '<',
            LESS_THAN_OR_EQUAL: '<=',
            GREATER_THAN: '>',
            GREATER_THAN_OR_EQUAL: '>=',

            EQUAL: '=',
            NOT_EQUAL: '<>',
            IS_NULL: 'IS NULL',
            IS_NOT_NULL: 'IS NOT NULL',
        },
        ARRAY: {
            BETWEEN: 'BETWEEN',
            NOT_BETWEEN: 'NOT BETWEEN',
            IN: 'IN',
            NOT_IN: 'NOT IN',
        },
    },
    BOOLEAN: {
        SINGLE: {
            EQUAL: '=',
            NOT_EQUAL: '<>',
            IS_NULL: 'IS NULL',
            IS_NOT_NULL: 'IS NOT NULL',
        },
        ARRAY: {},
    },
};

/**
 * Generates the input types for GraphQL based on the provided Postgres to Nexus objects.
 *
 * @param ob - The Postgres to Nexus objects.
 * @returns {(NexusEnumTypeDef<string> | NexusInputObjectTypeDef<string>)[]} The generated input types.
 */
const inputTypesGraphQL = (ob: PgToNexusObject[]): (NexusEnumTypeDef<string> | NexusInputObjectTypeDef<string>)[] => {
    const scalars = ['String', 'Int', 'Float', 'Boolean'];

    /**
     * Maps column types to input types.
     *
     * @param c - The columns.
     * @param t - The input definition block.
     * @param baseType - The base type.
     */
    const mapTypes = (c: Column[], t: InputDefinitionBlock<string>, baseType?: string) => {
        c.forEach(({ name: cName, oid }) => {
            const { isArray, type } = getType(oid);
            const validTypes = scalars.map(s => s.toLowerCase());

            if (!isArray && validTypes.includes(type)) {
                t.field(cName, { type: baseType ?? 'ConditionANDOrORWHERE' + toPascalCase(type) });
            }
        });
    };

    return [
        enumType({
            name: 'OrderByASCAndDESC',
            members: ['ASC', 'DESC'],
            description: 'Types used in Order By',
        }),
        ...scalars.flatMap(c => {
            const operatorsList = operatorsByType[c.toUpperCase() as keyof typeof operatorsByType];
            const existsArrayVersion = Object.keys(operatorsList.ARRAY).length > 0;

            const requiredTypes = [
                enumType({
                    name: 'ConditionsANDOrORSingle' + c,
                    members: Object.keys(operatorsList.SINGLE),
                    description: 'Types of conditions for scalar ' + c + ' used in Where',
                }),
                inputObjectType({
                    name: 'ConditionANDOrORWHERESingle' + c,
                    definition(t) {
                        t.nonNull.field('condition', { type: 'ConditionsANDOrORSingle' + c });
                        t.nullable[
                            c.toLowerCase() as keyof Omit<
                                InputDefinitionBlock<string>,
                                'nonNull' | 'nullable' | 'list' | 'typeName' | 'field'
                            >
                        ]('value');
                    },
                }),
                inputObjectType({
                    name: 'ConditionANDOrORWHERE' + c,
                    definition(t) {
                        t.field('SINGLE', { type: 'ConditionANDOrORWHERESingle' + c });
                        if (existsArrayVersion) {
                            t.field('ARRAY', { type: 'ConditionANDOrORWHEREArray' + c });
                        }
                    },
                }),
            ];

            const arrayTypes = [
                enumType({
                    name: 'ConditionsANDOrORArray' + c,
                    members: Object.keys(operatorsList.ARRAY),
                    description: 'Types of conditions for scalar ' + c + ' used in Where',
                }),
                inputObjectType({
                    name: 'ConditionANDOrORWHEREArray' + c,
                    definition(t) {
                        t.nonNull.field('condition', { type: 'ConditionsANDOrORArray' + c });
                        t.nonNull.list.nonNull[
                            c.toLowerCase() as keyof Omit<
                                InputDefinitionBlock<string>,
                                'nonNull' | 'nullable' | 'list' | 'typeName' | 'field'
                            >
                        ]('value');
                    },
                }),
            ];

            return existsArrayVersion ? [...requiredTypes, ...arrayTypes] : requiredTypes;
        }),
        ...ob
            .filter(o => o.table.operations.length > 0)
            .flatMap(({ name, table: { name: tableName, columns, cols, variables } }) => {
                const colsToMap = columns.filter(c =>
                    Array.isArray(cols) && cols.length > 0 ? cols.includes(c.name) : true,
                );

                return [
                    inputObjectType({
                        name: toPascalCase('and_' + pascalCaseToSnakeCase(name)),
                        description: `The AND filter of results retorned by ${toNameCase(
                            tableName.replace(/_/g, ' '),
                        )} (Postgres AND equivalent).`,
                        definition(t) {
                            mapTypes(colsToMap, t);
                            t.list.nonNull.field('AND', {
                                type: toPascalCase('and_' + pascalCaseToSnakeCase(name)),
                            });
                            t.list.nonNull.field('OR', {
                                type: toPascalCase('or_' + pascalCaseToSnakeCase(name)),
                            });
                        },
                    }),
                    inputObjectType({
                        name: toPascalCase('or_' + pascalCaseToSnakeCase(name)),
                        description: `The OR filter of results retorned by ${toNameCase(
                            tableName.replace(/_/g, ' '),
                        )} (Postgres OR equivalent).`,
                        definition(t) {
                            mapTypes(colsToMap, t);
                            t.list.nonNull.field('AND', {
                                type: toPascalCase('and_' + pascalCaseToSnakeCase(name)),
                            });
                            t.list.nonNull.field('OR', {
                                type: toPascalCase('or_' + pascalCaseToSnakeCase(name)),
                            });
                        },
                    }),
                    inputObjectType({
                        name: toPascalCase('where_' + pascalCaseToSnakeCase(name)),
                        description: `The filter of results retorned by ${toNameCase(
                            tableName.replace(/_/g, ' '),
                        )} (Postgres Where equivalent).`,
                        definition(t) {
                            t.list.nonNull.field('AND', {
                                type: toPascalCase('and_' + pascalCaseToSnakeCase(name)),
                            });
                            t.list.nonNull.field('OR', {
                                type: toPascalCase('or_' + pascalCaseToSnakeCase(name)),
                            });
                        },
                    }),
                    inputObjectType({
                        name: toPascalCase('order_by_' + pascalCaseToSnakeCase(name)),
                        description: `The ordering results retorned by ${toNameCase(
                            tableName.replace(/_/g, ' '),
                        )} (Postgres Order By equivalent).`,
                        definition(t) {
                            mapTypes(colsToMap, t, 'OrderByASCAndDESC');
                        },
                    }),
                    variables
                        ? inputObjectType({
                              name: toPascalCase('variables_' + pascalCaseToSnakeCase(name)),
                              description: `The variables for the ${toNameCase(tableName.replace(/_/g, ' '))}.`,
                              definition(t) {
                                  variables.forEach(({ name: vName, type: vType, nullable, description }) => {
                                      (nullable ? t.nullable : t.nonNull).field(vName, { type: vType, description });
                                  });
                              },
                          })
                        : undefined,
                ].filter(Boolean) as (NexusEnumTypeDef<string> | NexusInputObjectTypeDef<string>)[];
            }),
    ];
};

/**
 * Links the result with foreign keys by executing additional queries.
 *
 * @param foreignKeys - The foreign keys of the table.
 * @param table - The table object.
 * @param r - The query result rows.
 * @param credentials - The database credentials.
 * @returns {Promise<QueryResultRow[]>} A Promise that resolves to the modified query result rows with linked foreign keys.
 */
export const linkResultWithForeignsKeys = async (
    foreignKeys: Column[],
    table: Table,
    r: QueryResultRow[],
    credentials: ClientConfig,
): Promise<QueryResultRow[]> =>
    foreignKeys.length > 0
        ? await Promise.all(
              r.map(async rr => {
                  const foreignResults = await Promise.all(
                      foreignKeys.map(({ foreignKey: { data }, type, name }) =>
                          data != undefined && typeof rr[name] != 'undefined'
                              ? {
                                    name,
                                    referencedTable: data.referencedTable,
                                    result: execQuery(
                                        credentials,
                                        `SELECT * FROM 
                                            ${data.referencedSchema}.${data.referencedTable} 
                                        WHERE
                                            ${data.referencedColumn} = '${rr[name]}'::${type}
                                        LIMIT 1`,
                                    )
                                        .then(res => res?.rows ?? [])
                                        .then(res => (res.length > 0 ? res[0] : null)),
                                }
                              : {
                                    name,
                                    referencedTable: data?.referencedTable,
                                    result: null,
                                },
                      ),
                  );

                  const res: QueryResultRow = {};

                  table.columns
                      .filter(({ foreignKey: { is, data } }) => !is || data?.nexusObjectName == undefined)
                      .forEach(({ name: colName }) => {
                          if (typeof rr[colName] != 'undefined') {
                              res[colName] = rr[colName];
                          } else {
                              res[colName] = null;
                          }
                      });

                  foreignResults.forEach(({ name: colName, result: v, referencedTable }) => {
                      const customName =
                          referencedTable && table.columns.find(cc => cc.name === referencedTable) === undefined
                              ? referencedTable
                              : colName;

                      res[customName] = v;
                  });

                  return res;
              }),
          )
        : r;

/**Generates the JSDoc and TSDoc for the generateSchema function.
 * @param {ClientConfig} credentials - The credentials for the database client.
 * @param {Schema[]} dbSchema - The database schema.
 * @param {GenerateSchemaOptions} [options] - The options for generating the schema.
 * @returns {Promise<(NexusEnumTypeDef<string> | NexusInputObjectTypeDef<string> | NexusObjectTypeDef<string> | undefined)[]>} The generated schema types.
 */
export const generateSchema = async (
    credentials: ClientConfig,
    dbSchema: Schema[],
    options?: GenerateSchemaOptions,
): Promise<(NexusEnumTypeDef<string> | NexusInputObjectTypeDef<string> | NexusObjectTypeDef<string> | undefined)[]> => {
    const objectsName: PgToNexusObject[] = [];
    const opt = options ?? defaultGenerateSchemaOptions;

    const { linkForeignKeysToTables: linkForeign, generateForeignTables: genForeign } = opt;

    const addObjectName = (s: Schema, t: Table) => {
        const { name: rawName, columns } = t;

        if (columns.length > 0) {
            let approvedName = false;
            let i = 0;
            let name = toPascalCase(s.name + '_' + rawName).replace(/[\W_]+/g, '');

            while (!approvedName) {
                if (i != 0) {
                    name = name + i;
                }

                const sameObjectName = objectsName.filter(o => o.name === name);
                if (sameObjectName.length <= 0) {
                    objectsName.push({
                        name,
                        table: t,
                        schema: { name: s.name },
                    });
                    approvedName = true;
                    break;
                }

                i++;
            }
        }
    };

    //Generate the Nexus objects names
    dbSchema.forEach(s => s.tables.forEach(t => addObjectName(s, t)));

    if (genForeign) {
        let schemas: SchemaOptions[] = [];

        objectsName.forEach(ob => {
            ob.table.columns.forEach(async c => {
                const {
                    foreignKey: { is, data },
                } = c;

                if (
                    is &&
                    data !== undefined &&
                    objectsName.find(
                        o => o.schema.name === data.referencedSchema && o.table.name === data.referencedTable,
                    ) === undefined
                ) {
                    const { referencedSchema, referencedTable } = data;

                    const schema = schemas.find(sc => sc.name == referencedSchema);

                    if (schema) {
                        schemas = [
                            ...schemas.filter(sc => sc.name != referencedSchema),
                            {
                                ...schema,
                                tables: [...schema.tables, { name: referencedTable, operations: [] }],
                            },
                        ];
                    } else {
                        schemas.push({
                            name: referencedSchema,
                            tables: [{ name: referencedTable, operations: [] }],
                        });
                    }
                }
            });
        });

        if (schemas.length > 0) {
            const dbSchemaLinked = await generateDBSchema(credentials, {
                schemas,
            });

            dbSchemaLinked.forEach(s => s.tables.forEach(t => addObjectName(s, t)));
        }
    }

    //Function to treat the names
    const treatName = (name: string, operation: Operations) => {
        const obs = objectsName.filter(o => o.name.includes(name.replace(/\d+/g, '')) && o.name !== name);
        let nameInUseForThisOperation = false;

        if (obs.length > 0) {
            obs.forEach(ob => {
                if (ob.table.operations.includes(operation)) {
                    nameInUseForThisOperation = true;
                }
            });
        }

        return nameInUseForThisOperation ? name : name.replace(/\d+/g, '');
    };

    return [
        ...objectsName
            .flatMap(({ name, table: { columns, description, operations, cols } }) => {
                const colsToMap = columns.filter(c =>
                    Array.isArray(cols) && cols.length > 0 ? cols.includes(c.name) : true,
                );

                return [
                    objectType({
                        name,
                        description,
                        definition(t) {
                            colsToMap.forEach(c =>
                                columnType(t, {
                                    ...c,
                                    name:
                                        c.foreignKey.is &&
                                        c.foreignKey.data !== undefined &&
                                        linkForeign &&
                                        colsToMap.find(cc => cc.name === c.foreignKey.data?.referencedTable) ===
                                            undefined
                                            ? c.foreignKey.data.referencedTable
                                            : c.name,
                                    foreignKey:
                                        c.foreignKey.is && c.foreignKey.data !== undefined && linkForeign
                                            ? {
                                                  ...c.foreignKey,
                                                  data: {
                                                      ...c.foreignKey.data,
                                                      nexusObjectName: objectsName.find(
                                                          o =>
                                                              o.schema.name === c.foreignKey.data?.referencedSchema &&
                                                              o.table.name === c.foreignKey.data.referencedTable,
                                                      )?.name,
                                                  },
                                              }
                                            : c.foreignKey,
                                }),
                            );
                        },
                    }),
                    operations.includes('CREATE')
                        ? inputObjectType({
                              name: toPascalCase(pascalCaseToSnakeCase(name + 'MutationCreate')),
                              description,
                              definition(t) {
                                  columns
                                      .filter(c =>
                                          Array.isArray(cols) && cols.length > 0
                                              ? !c.nullable || cols.includes(c.name)
                                              : true,
                                      )
                                      .forEach(c => columnInputType(t, c));
                              },
                          })
                        : undefined,
                    operations.includes('UPDATE')
                        ? inputObjectType({
                              name: toPascalCase(pascalCaseToSnakeCase(name + 'MutationUpdate')),
                              description,
                              definition(t) {
                                  colsToMap.forEach(c => columnInputType(t, { ...c, nullable: true }));
                              },
                          })
                        : undefined,
                ];
            })
            .filter(o => o !== undefined),
        ...objectsName
            .flatMap(({ name, table: { description, operations } }) => [
                operations.includes('READ')
                    ? objectType({
                          name: toPascalCase(pascalCaseToSnakeCase('QueryType' + name)),
                          description,
                          definition(t) {
                              t.nonNull.int('pages');
                              t.nonNull.int('totalRows');
                              t.nonNull.int('currentPage');
                              t.nonNull.int('rowsPerPage');
                              t.nonNull.boolean('hasNextPage');
                              t.nonNull.list.nonNull.field('results', {
                                  type: name,
                              });
                          },
                      })
                    : undefined,
                operations.includes('CREATE') || operations.includes('UPDATE')
                    ? objectType({
                          name: toPascalCase(pascalCaseToSnakeCase('MutationType' + name)),
                          description,
                          definition(t) {
                              t.nonNull.int('rowsAffected');
                              t.nonNull.list.nonNull.field('results', {
                                  type: name,
                              });
                          },
                      })
                    : undefined,
            ])
            .filter(o => o !== undefined),
        ...pgTypesToGraphQLCustomObjects(),
        ...inputTypesGraphQL(objectsName),
        objectsName
            .map(
                ({ table }) =>
                    table.operations.includes('CREATE') ||
                    table.operations.includes('UPDATE') ||
                    table.operations.includes('DELETE'),
            )
            .some(Boolean)
            ? mutationType({
                  definition(t) {
                      objectsName.forEach(({ name, table, schema: s }) => {
                          if (table.operations.includes('CREATE')) {
                              t.nonNull.field(toCamelCase('create' + treatName(name, 'CREATE')), {
                                  type: toPascalCase(pascalCaseToSnakeCase('MutationType' + name)),
                                  args: {
                                      values: nonNull(
                                          list(
                                              nonNull(
                                                  arg({
                                                      type: toPascalCase(
                                                          pascalCaseToSnakeCase(name + 'MutationCreate'),
                                                      ),
                                                  }),
                                              ),
                                          ),
                                      ),
                                  },
                                  description: 'Create a new ' + toNameCase(table.name.replace(/_/g, ' ')) + '.',
                                  resolve: async (_root, args) => {
                                      const { query, values } = makeMutationCreate(s, table, args.values);

                                      const r: QueryResultRow[] = await execQuery(credentials, query, values).then(
                                          r => r?.rows ?? [],
                                      );

                                      const fks = table.columns.filter(
                                          c => c.foreignKey.is && c.foreignKey.data != undefined && linkForeign,
                                      );

                                      const finalResult = await linkResultWithForeignsKeys(
                                          fks,
                                          table,
                                          r,
                                          credentials,
                                      ).then(r => r.filter(Boolean));

                                      return { rowsAffected: finalResult.length, results: finalResult };
                                  },
                              });
                          }

                          if (table.operations.includes('UPDATE')) {
                              t.nonNull.field(toCamelCase('update' + treatName(name, 'UPDATE')), {
                                  type: toPascalCase(pascalCaseToSnakeCase('MutationType' + name)),
                                  args: {
                                      value: nonNull(
                                          arg({ type: toPascalCase(pascalCaseToSnakeCase(name + 'MutationUpdate')) }),
                                      ),
                                      where: nonNull(
                                          arg({
                                              type: toPascalCase('where_' + pascalCaseToSnakeCase(name)),
                                              description: 'Where for the update in database',
                                          }),
                                      ),
                                  },
                                  description: 'Update a existing ' + toNameCase(table.name.replace(/_/g, ' ')) + '.',
                                  resolve: async (_root, args) => {
                                      const { query, values } = makeMutationUpdate(s, table, args.value, args.where);

                                      const r: QueryResultRow[] = await execQuery(credentials, query, values).then(
                                          r => r?.rows ?? [],
                                      );

                                      const fks = table.columns.filter(
                                          c => c.foreignKey.is && c.foreignKey.data != undefined && linkForeign,
                                      );

                                      const finalResult = await linkResultWithForeignsKeys(
                                          fks,
                                          table,
                                          r,
                                          credentials,
                                      ).then(r => r.filter(Boolean));

                                      return { rowsAffected: finalResult.length, results: finalResult };
                                  },
                              });
                          }

                          if (table.operations.includes('DELETE')) {
                              t.nonNull.field(toCamelCase('delete' + treatName(name, 'DELETE')), {
                                  type: toPascalCase(pascalCaseToSnakeCase('MutationType' + name)),
                                  args: {
                                      where: nonNull(
                                          arg({
                                              type: toPascalCase('where_' + pascalCaseToSnakeCase(name)),
                                              description: 'Where for the delete in database',
                                          }),
                                      ),
                                  },
                                  description: 'Delete a existing ' + toNameCase(table.name.replace(/_/g, ' ')) + '.',
                                  resolve: async (_root, args) => {
                                      const { query, values } = makeMutationDelete(s, table, args.where);

                                      const r: QueryResultRow[] = await execQuery(credentials, query, values).then(
                                          r => r?.rows ?? [],
                                      );

                                      const fks = table.columns.filter(
                                          c => c.foreignKey.is && c.foreignKey.data != undefined && linkForeign,
                                      );

                                      const finalResult = await linkResultWithForeignsKeys(
                                          fks,
                                          table,
                                          r,
                                          credentials,
                                      ).then(r => r.filter(Boolean));

                                      return { rowsAffected: finalResult.length, results: finalResult };
                                  },
                              });
                          }
                      });
                  },
              })
            : undefined,
        objectsName.map(({ table }) => table.operations.includes('READ')).some(Boolean)
            ? queryType({
                  definition(t) {
                      objectsName.forEach(({ name, table, schema: s }) => {
                          if (table.operations.includes('READ')) {
                              t.nonNull.field(toCamelCase('get' + treatName(name, 'READ')), {
                                  type: toPascalCase(pascalCaseToSnakeCase('QueryType' + name)),
                                  args: {
                                      page: nonNull(
                                          intArg({
                                              default: 1,
                                              description: 'The page number where the data must be consulted',
                                          }),
                                      ),
                                      maxRows: nonNull(
                                          intArg({
                                              default: 20,
                                              description: 'The number of results that can be returned (max is 100)',
                                          }),
                                      ),
                                      where: arg({
                                          type: toPascalCase('where_' + pascalCaseToSnakeCase(name)),
                                          description: 'Where for the query in database',
                                      }),
                                      variables: table.variables
                                          ? arg({
                                                type: toPascalCase('variables_' + name),
                                                description: 'Custom variables for the query in database',
                                            })
                                          : undefined,
                                      orderBy: arg({
                                          type: toPascalCase('order_by_' + pascalCaseToSnakeCase(name)),
                                          description: 'Ordering for the query in database',
                                      }),
                                  },
                                  description:
                                      'Get results for the object ' + toNameCase(table.name.replace(/_/g, ' ')) + '.',
                                  resolve: async (_root, args) => {
                                      const numberOfResults = (
                                          args.maxRows <= 100 && args.maxRows > 0 ? args.maxRows : 100
                                      ) as number;
                                      const pageNumber = Number(args.page) >= 0 ? Number(args.page) - 1 : 0;

                                      const { query, values, whereQuery } = makeQuery(
                                          s,
                                          table,
                                          numberOfResults,
                                          pageNumber * numberOfResults,
                                          args.where,
                                          args.variable,
                                          args.orderBy,
                                      );

                                      const r: QueryResultRow[] = await execQuery(credentials, query, values).then(
                                          r => r?.rows ?? [],
                                      );

                                      const fks = table.columns.filter(
                                          c => c.foreignKey.is && c.foreignKey.data != undefined && linkForeign,
                                      );

                                      const finalResult = await linkResultWithForeignsKeys(fks, table, r, credentials);

                                      let { pages, total_rows: totalRows } =
                                          (await execQuery<{
                                              pages?: number;
                                              total_rows?: number;
                                          }>(
                                              credentials,
                                              getPagesQuery(
                                                  s.name,
                                                  table.name,
                                                  whereQuery
                                                      ? { sql: whereQuery, finalIndex: values.length - 1 }
                                                      : undefined,
                                              ),
                                              [...values.slice(0, -2), numberOfResults],
                                          ).then(r => (r?.rows ?? [])[0])) ?? {};

                                      pages = Number(pages);
                                      totalRows = Number(totalRows);

                                      return {
                                          pages: typeof pages != 'number' || Number.isNaN(pages) ? 1 : pages + 1,
                                          totalRows:
                                              typeof totalRows != 'number' || Number.isNaN(totalRows) ? 0 : totalRows,
                                          currentPage: pageNumber <= 0 ? 1 : pageNumber,
                                          rowsPerPage: numberOfResults,
                                          hasNextPage:
                                              (typeof pages != 'number' || Number.isNaN(pages) ? 0 : pages) -
                                                  pageNumber >
                                              0,
                                          results: finalResult.filter(Boolean),
                                      };
                                  },
                              });
                          }
                      });
                  },
              })
            : undefined,
    ].filter(Boolean);
};

/**
 * Generates the input type for a column based on its PostgreSQL definition.
 *
 * @param t - The input definition block.
 * @param c - The column object.
 */
export const columnInputType = <T extends string = string>(t: InputDefinitionBlock<T>, c: Column) => {
    const { name, nullable, isPrimaryKey, description, oid } = c;
    let tt = nullable ? t.nullable : t.nonNull;

    if (isPrimaryKey) {
        tt.id(name, { description });
    } else {
        const { isArray, type } = getType(oid);

        if (isArray) {
            tt = nullable ? tt.list.nullable : tt.list.nonNull;
        }

        switch (type) {
            case 'string':
                tt.string(name, { description });
                break;
            case 'int':
                tt.int(name, { description });
                break;
            case 'float':
                tt.float(name, { description });
                break;
            case 'boolean':
                tt.boolean(name, { description });
                break;
            default:
                tt.string(name, { description });
                break;
        }
    }
};

/**
 * Generates the type for a column based on its PostgreSQL definition.
 *
 * @param t - The object definition block.
 * @param c - The column object.
 */
export const columnType = <T extends string = string>(t: ObjectDefinitionBlock<T>, c: Column) => {
    const {
        name,
        nullable,
        foreignKey: { is, data: foreignKeyData },
        isPrimaryKey,
        description,
        oid,
    } = c;
    let tt = nullable ? t.nullable : t.nonNull;

    if (isPrimaryKey) {
        tt.id(name, { description });
    } else if (is && foreignKeyData?.nexusObjectName) {
        const { nexusObjectName } = foreignKeyData;

        tt.field(name, {
            type: nexusObjectName,
            description,
        });
    } else {
        const { isArray, type } = getType(oid);

        if (isArray) {
            tt = nullable ? tt.list.nullable : tt.list.nonNull;
        }

        switch (type) {
            case 'string':
                tt.string(name, { description });
                break;
            case 'int':
                tt.int(name, { description });
                break;
            case 'float':
                tt.float(name, { description });
                break;
            case 'boolean':
                tt.boolean(name, { description });
                break;
            case 'Point':
                tt.field(name, { type, description });
                break;
            case 'Circle':
                tt.field(name, { type, description });
                break;
            case 'Interval':
                tt.field(name, { type, description });
                break;
            default:
                tt.string(name, { description });
                break;
        }
    }
};

export default generateSchema;
