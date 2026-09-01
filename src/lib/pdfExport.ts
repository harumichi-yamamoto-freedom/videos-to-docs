export type DateLike = Date | { toDate(): Date };

const PDF_TIME_ZONE = 'Asia/Tokyo';
const MAX_FILE_STEM_CODE_POINTS = 100;

const displayDateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: PDF_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

const fileDateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: PDF_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

const WINDOWS_RESERVED_NAME =
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

export function dateLikeToDate(value: DateLike): Date {
    return value instanceof Date ? value : value.toDate();
}

export function formatPdfDateTime(value: DateLike): string {
    return displayDateTimeFormatter.format(dateLikeToDate(value));
}

function getDateTimePart(
    parts: Intl.DateTimeFormatPart[],
    type: Intl.DateTimeFormatPartTypes,
): string {
    const part = parts.find(candidate => candidate.type === type);

    if (!part) {
        throw new Error(`PDF日時の${type}を取得できませんでした`);
    }

    return part.value;
}

function formatPdfFileDateTime(value: DateLike): string {
    const parts = fileDateTimeFormatter.formatToParts(dateLikeToDate(value));
    const year = getDateTimePart(parts, 'year');
    const month = getDateTimePart(parts, 'month');
    const day = getDateTimePart(parts, 'day');
    const hour = getDateTimePart(parts, 'hour');
    const minute = getDateTimePart(parts, 'minute');

    return `${year}${month}${day}-${hour}${minute}`;
}

export function sanitizeFileStem(value: string): string {
    let sanitized = value
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/gu, '_')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/[ .]+$/u, '');

    if (!sanitized) {
        return 'document';
    }

    if (WINDOWS_RESERVED_NAME.test(sanitized)) {
        sanitized = `_${sanitized}`;
    }

    sanitized = Array.from(sanitized)
        .slice(0, MAX_FILE_STEM_CODE_POINTS)
        .join('')
        .replace(/[ .]+$/u, '');

    return sanitized || 'document';
}

export function buildPdfFileStem(document: {
    title: string;
    createdAt?: DateLike;
}): string {
    const createdAt = document.createdAt ?? new Date();

    return `${sanitizeFileStem(document.title)}_${formatPdfFileDateTime(createdAt)}`;
}
