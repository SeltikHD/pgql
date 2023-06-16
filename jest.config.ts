import { type JestConfigWithTsJest } from 'ts-jest';

const config: JestConfigWithTsJest = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[tj]s?(x)'],
    testPathIgnorePatterns: ['/node_modules/'],
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                compiler: 'ttypescript',
            },
        ],
        '/.*\\.ts/g': [
            'ts-jest',
            {
                compiler: 'ttypescript',
            },
        ],
    },
    setupFilesAfterEnv: ['jest-expect-message' /*, './tests/custom/setupJest.ts'*/],
};

export default config;
