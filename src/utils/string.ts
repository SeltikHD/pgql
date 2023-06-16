export function replaceNull(_: any, value: any) {
    return value === null ? undefined : value;
}

export function matchGitignorePattern(pattern: string, str: string): boolean {
    // Converte os caracteres especiais do .gitignore em regex
    const regex = pattern
        // eslint-disable-next-line no-useless-escape
        .replace(/[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g, '\\$&')
        .replace(/[*]/g, '.*')
        .replace(/[?]/g, '.{1}');

    const regexp = new RegExp(`^${regex}$`);

    // Verifica se a string corresponde ao padrão do .gitignore
    return regexp.test(str);
}

export function toNameCase(stri: string) {
    const splitStr = stri.toLowerCase().split(/\s|\(+/);

    splitStr.forEach((str, i) => {
        splitStr[i] =
            str != 'de' && str != 'do' && str != 'da' && str != 'por'
                ? (stri.charAt(stri.toLowerCase().indexOf(str) - 1) != ' '
                      ? stri.charAt(stri.toLowerCase().indexOf(str) - 1)
                      : '') +
                  str.charAt(0).toUpperCase() +
                  str.substring(1)
                : str;
    });

    return splitStr.join(' ').replace(/( {2})+/g, ' ');
}

export function toCamelCase(str: string): string {
    const parts = str.split(/[_\- ]+/);
    const first = parts.shift();
    return first + parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

export const toPascalCase = (s: string) =>
    s
        .replace(/[^a-zA-Z0-9]/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');

export const pascalCaseToSnakeCase = (s: string) =>
    s.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/^_/, '');
