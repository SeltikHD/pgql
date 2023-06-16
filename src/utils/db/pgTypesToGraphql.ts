import { objectType } from 'nexus';

export type Scalar = 'string' | 'int' | 'float' | 'boolean';
export type CustomScalar = 'Point' | 'Circle' | 'Interval';
export type TypeObject = { [x: number]: { type: Scalar | CustomScalar; isArray: boolean } };

export function pgTypesToGraphQLCustomObjects() {
    return [
        objectType({
            name: 'Point',
            description:
                'The point data type is one of the Postgres geometric types, meant to represent a point on a two dimensional plane.',
            definition(t) {
                t.float('x', { description: 'The x position of the point' });
                t.float('y', { description: 'The y position of the point' });
            },
        }),
        objectType({
            name: 'Circle',
            description: 'Circles are represented by a center point and radius. ',
            definition(t) {
                t.float('x', { description: 'The x position of the center point of the circle' });
                t.float('y', { description: 'The y position of the center point of the circle' });
                t.float('radius', { description: 'The radius of the circle' });
            },
        }),
        objectType({
            name: 'Interval',
            description: 'In PostgreSQL the interval data type is used to store and manipulate a time period.',
            definition(t) {
                t.nullable.int('years');
                t.nullable.int('months');
                t.nullable.int('days');
                t.nullable.int('hours');
                t.nullable.int('minutes');
                t.nullable.int('seconds');
                t.nullable.int('milliseconds');
                t.string('ISO');
                t.string('ISOString');
                t.string('postgres');
            },
        }),
    ];
}

export function getType(oid: number) {
    const types = {} as TypeObject;

    const register = (oid: number, type?: Scalar | CustomScalar, isArray?: boolean) => {
        types[oid] = { type: type ?? 'string', isArray: isArray ?? false };
    };

    register(20, 'int'); // int8
    register(21, 'int'); // int2
    register(23, 'int'); // int4
    register(26, 'int'); // oid
    register(1700, 'float'); // numeric
    register(700, 'float'); // float4/real
    register(701, 'float'); // float8/double
    register(16, 'boolean'); // bool
    register(1082, 'string'); // date
    register(1114, 'string'); // timestamp without timezone
    register(1184, 'string'); // timestamp
    register(600, 'Point'); // point
    register(651, 'string', true); // cidr[]
    register(718, 'Circle'); // circle
    register(1000, 'boolean', true); // bool[]
    register(1001, 'string', true); // byte[][]
    register(1005, 'int', true); // _int2
    register(1007, 'int', true); // _int4
    register(1028, 'int', true); // oid[]
    register(1016, 'int', true); // _int8
    register(1017, 'Point', true); // point[]
    register(1021, 'float', true); // _float4
    register(1022, 'float', true); // _float8
    register(1231, 'float', true); // _numeric
    register(1014, 'string', true); // char
    register(1015, 'string', true); // varchar
    register(1008, 'string', true); // string[]
    register(1009, 'string', true); // string []
    register(1040, 'string', true); // macaddr[]
    register(1041, 'string', true); // inet[]
    register(1115, 'string', true); // timestamp without time zone[]
    register(1182, 'string', true); // _date
    register(1185, 'string', true); // timestamp with time zone[]
    register(1186, 'Interval'); // interval
    register(1187, 'Interval', true); // interval[]
    register(17, 'string'); // byte[]
    register(114, 'string'); // json
    register(3802, 'string'); // jsonb
    register(199, 'string', true); // json[]
    register(3807, 'string', true); // jsonb[]
    register(3907, 'string', true); // numrange[]
    register(2951, 'string', true); // uuid[]
    register(791, 'string', true); // money[]
    register(1183, 'string', true); // time[]
    register(1270, 'string', true); // timetz[]

    return types[oid] || { type: 'string' };
}
