# pgql

pgql is a TypeScript library that provides automatic bridging between SQL and GraphQL APIs. It allows you to generate Nexus objects that can be used with GraphQL, enabling seamless integration between your database and API.

## Features

- Automatic generation of GraphQL schema based on your PostgreSQL database schema.
- Support for CRUD operations (CREATE, READ, UPDATE, DELETE).
- Integration with popular frameworks like Express and Next.js.
- Built-in support for TypeScript

## Installation

NPM

```bash
npm install pgql
```

Yarn

```bash
yarn install pgql
```

PNpm

```bash
pnpm install pgql
```

## Usage

### Next.js Example

```typescript
// pages/api/graphql/index.ts
import { NextApiRequest, NextApiResponse } from 'next';
import { createSchema } from './services/graphql/schema';
import { createYoga } from 'graphql-yoga';

export default createYoga<{
    req: NextApiRequest;
    res: NextApiResponse;
}>({
    graphqlEndpoint: '/api/graphql/',
    graphiql: { title: 'My GraphQL Playground' },
    batching: true,
    schema: await createSchema(),
});

// services/graphql/schema.ts
import { generateDBSchema } from 'pgql';
import { makeSchema } from 'nexus';

export async function createSchema() {
    const credentials = {};

    const dbSchema = await generateDBSchema(credentials, {
        schemas: [
            {
                name: 'website',
                tables: [
                    {
                        name: 'user',
                        operations: ['READ'],
                        defaultWhere: `id IS NOT NULL`,
                        cols: ['id', 'name', 'email'],
                    },
                    { name: 'payment', operations: ['CREATE', 'READ', 'UPDATE', 'DELETE'] },
                ],
                views: [{ name: 'payments_per_user', operations: ['READ'] }],
            },
        ],
        generateForeignTables: true,
    });

    const types = await generateSchema(credentials, dbSchema);

    return makeSchema({
        types,
    });
}
```

## License

This project is licensed under the ISC License - see the [LICENSE](https://opensource.org/license/isc-license-txt/) file for details.

## Contributing

Contributions are welcome! Fork the repository, make your changes, and submit a pull request.

## Support

If you have any questions, issues, or feature requests, please [create an issue](https://github.com/SeltikHD/pgql/issues) on the repository.
