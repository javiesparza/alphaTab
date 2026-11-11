const extensions = new Set([
    '.gp',
    '.gp3',
    '.gp4',
    '.gp5',
    '.gpx',
    '.gp7',
    '.gp8',
    '.xml',
    '.musicxml',
    '.mxl',
    '.capx',
    '.alphatex',
    '.atex',
    '.tex',
    '.txt'
]);

export const FILE_ACCEPT = [...extensions].join(',');

export function isScoreFileName(name: string): boolean {
    return extensions.has(name.slice(name.lastIndexOf('.')).toLowerCase());
}
