export function removeDuplicates<T extends object>(values: T[]) {
    type KeysFunctions = {
        interfaceKeys: (<D extends object>() => Array<keyof D>) | null;
        keysByValue: <F extends object>(value: F) => Array<keyof F>;
    };

    const keysFunctions: KeysFunctions = {
        interfaceKeys: null,
        keysByValue: <F extends object>(value: F) => Object.keys(value) as Array<keyof F>,
    };

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const interfaceKeys = require('ts-transformer-keys').keys as <D extends object>() => Array<keyof D>;
        keysFunctions.interfaceKeys = <D extends object>() => interfaceKeys<D>();
    } catch {
        keysFunctions.interfaceKeys = null;
    }

    if (values.length > 0) {
        let keys = [] as (keyof T)[];

        keys = keysFunctions.interfaceKeys ? keysFunctions.interfaceKeys<T>() : keysFunctions.keysByValue(values[0]);

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

export function mergeObjectsWithSameName<T extends object>(objects: T[], delimiter: keyof T): T[] {
    const mergedObjects: { [name: string]: T } = {};

    for (const obj of objects) {
        const name = obj[delimiter] as unknown as string;
        const existingObj = mergedObjects[name];

        if (existingObj) {
            mergedObjects[name] = mergeObjects(existingObj, obj);
        } else {
            mergedObjects[name] = obj;
        }
    }

    return Object.values(mergedObjects);
}

function mergeObjects<T extends object>(obj1: T, obj2: T): T {
    const mergedObj = { ...obj1 };

    for (const key in obj2) {
        if (Array.isArray(obj1[key]) && Array.isArray(obj2[key])) {
            mergedObj[key] = removeDuplicates([
                ...(obj1[key] as Array<any>),
                ...(obj2[key] as Array<any>),
            ]) as unknown as T[Extract<keyof T, string>];
        } else {
            mergedObj[key] = obj2[key];
        }
    }

    return mergedObj;
}
