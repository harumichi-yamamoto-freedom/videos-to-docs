type LogLevel = 'info' | 'warn' | 'error';

type LogMetadata = Record<string, unknown>;

interface Logger {
    info: (message: string, metadata?: LogMetadata) => void;
    warn: (message: string, metadata?: LogMetadata) => void;
    error: (message: string, error?: unknown, metadata?: LogMetadata) => void;
}

const outputByLevel: Record<LogLevel, (...args: unknown[]) => void> = {
    info: console.info,
    warn: console.warn,
    error: console.error,
};

function formatMessage(scope: string, level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${scope}] [${level.toUpperCase()}] ${message}`;
}

function buildPayload(metadata?: LogMetadata): string | undefined {
    if (!metadata || Object.keys(metadata).length === 0) {
        return undefined;
    }
    try {
        return JSON.stringify(metadata);
    } catch {
        return '[metadata-serialization-error]';
    }
}

function log(scope: string, level: LogLevel, message: string, metadata?: LogMetadata, error?: unknown): void {
    const output = outputByLevel[level];
    const formatted = formatMessage(scope, level, message);
    const metadataPayload = buildPayload(metadata);

    if (error && metadataPayload) {
        output(formatted, metadataPayload, error);
        return;
    }

    if (error) {
        output(formatted, error);
        return;
    }

    if (metadataPayload) {
        output(formatted, metadataPayload);
        return;
    }

    output(formatted);
}

export function createLogger(scope: string): Logger {
    return {
        info: (message, metadata) => log(scope, 'info', message, metadata),
        warn: (message, metadata) => log(scope, 'warn', message, metadata),
        error: (message, error, metadata) => log(scope, 'error', message, metadata, error),
    };
}




