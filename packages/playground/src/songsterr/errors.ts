export class ImportError extends Error {
    constructor(
        message: string,
        public readonly status = 422
    ) {
        super(message);
        this.name = 'ImportError';
    }
}
