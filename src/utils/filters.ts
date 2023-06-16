import { keys as interfaceKeys } from 'ts-transformer-keys';

export function removeDuplicates<T extends object>(values: T[]) {
    if (values.length > 0) {
        let keys = [] as (keyof T)[];

        try {
            keys = interfaceKeys<T>();
        } catch {
            keys = Object.keys(values[0]) as Array<keyof T>;
        }

        if (keys.length <= 0) {
            keys = Object.keys(values[0]) as Array<keyof T>;
        }

        return values.filter(
            (value, index, self) =>
                index ===
                self.findIndex(t => {
                    return keys.map(k => t[k] === value[k]).every(k => k === true);
                }),
        );
    }

    return values;
}
