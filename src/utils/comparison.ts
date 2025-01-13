export function shallowEqualStrict<T extends object>(obj1: T, obj2: T): boolean {
    const keys1 = Object.keys(obj1) as Array<keyof T>;
    if (keys1.length !== Object.keys(obj2).length) return false;
    return keys1.every((key) => obj1[key] === obj2[key]);
}
