import { describe, expect, it, vi } from 'vitest';
import {
    buildPdfFileStem,
    dateLikeToDate,
    formatPdfDateTime,
    sanitizeFileStem,
} from './pdfExport';

describe('dateLikeToDate', () => {
    it('Date をそのまま返す', () => {
        const date = new Date('2026-09-01T05:30:00.000Z');

        expect(dateLikeToDate(date)).toBe(date);
    });

    it('Firestore Timestamp 互換値を Date に変換する', () => {
        const date = new Date('2026-09-01T05:30:00.000Z');
        const timestamp = { toDate: () => date };

        expect(dateLikeToDate(timestamp)).toBe(date);
    });
});

describe('formatPdfDateTime', () => {
    it('Date を Asia/Tokyo・ja-JP の表示形式にする', () => {
        const date = new Date('2026-09-01T05:30:00.000Z');

        expect(formatPdfDateTime(date)).toBe('2026年9月1日 14:30');
    });

    it('Timestamp 互換値も表示できる', () => {
        const timestamp = {
            toDate: () => new Date('2026-09-01T05:30:00.000Z'),
        };

        expect(formatPdfDateTime(timestamp)).toBe('2026年9月1日 14:30');
    });

    it('UTC では前日でも Asia/Tokyo の日付境界を使う', () => {
        const date = new Date('2026-08-31T15:00:00.000Z');

        expect(formatPdfDateTime(date)).toBe('2026年9月1日 00:00');
    });
});

describe('sanitizeFileStem', () => {
    it('制御文字とファイル名の禁止文字をアンダースコアへ置換する', () => {
        expect(
            sanitizeFileStem(
                '議事<録>:"資料/動画\\共有|確認?済*\u0000\u001f\u007f\u0085',
            ),
        ).toBe('議事_録___資料_動画_共有_確認_済_____');
    });

    it('連続空白を整理し末尾の空白とピリオドを除去する', () => {
        expect(sanitizeFileStem('  週次\t 会議   資料...  ')).toBe(
            '週次_ 会議 資料',
        );
    });

    it('絵文字と絵文字内の ZWJ を保持する', () => {
        expect(sanitizeFileStem('発表🚀👨‍👩‍👧‍👦まとめ')).toBe(
            '発表🚀👨‍👩‍👧‍👦まとめ',
        );
    });

    it('U+200B 単独タイトルを可視文字へ置換する', () => {
        expect(sanitizeFileStem('\u200B')).toBe('_');
    });

    it('RLO を含むタイトルから表示順制御を除去する', () => {
        expect(sanitizeFileStem('議事録\u202Efdp')).toBe('議事録_fdp');
    });

    it('孤立サロゲートを置換する', () => {
        expect(sanitizeFileStem('議事録\uD800\uDC00末尾')).toBe(
            '議事録𐀀末尾',
        );
        expect(sanitizeFileStem('high\uD800-low\uDC00')).toBe('high_-low_');
    });

    it('結合文字を NFC に正規化する', () => {
        expect(sanitizeFileStem('Cafe\u0301')).toBe('Café');
    });

    it.each([
        'CON',
        'prn',
        'Aux.txt',
        'NUL',
        'com1',
        'LPT9.log',
        'COM¹',
        'com².txt',
        'LPT³.log',
    ])(
        'Windows 予約名 %s を回避する',
        reservedName => {
            expect(sanitizeFileStem(reservedName)).toBe(`_${reservedName}`);
        },
    );

    it('空白とピリオドだけのタイトルには document を使う', () => {
        expect(sanitizeFileStem('   ...  ')).toBe('document');
    });

    it('100 Unicode code point に制限しサロゲートペアを分断しない', () => {
        const longTitle = `${'あ'.repeat(99)}🚀末尾`;
        const sanitized = sanitizeFileStem(longTitle);

        expect(Array.from(sanitized)).toHaveLength(100);
        expect(sanitized).toBe(`${'あ'.repeat(99)}🚀`);
    });

    it('切り詰めで末尾になったピリオドも除去する', () => {
        const longTitle = `${'あ'.repeat(99)}.${'い'.repeat(10)}`;

        expect(sanitizeFileStem(longTitle)).toBe('あ'.repeat(99));
    });

    it('切り詰めと末尾除去で再生成された Windows 予約名を回避する', () => {
        const regeneratedReservedName = `CON ${'.'.repeat(96)}x`;

        expect(sanitizeFileStem(regeneratedReservedName)).toBe('_CON');
    });

    it('長い Windows 予約名を回避しても100 code pointを超えない', () => {
        const reservedName = `CON.${'x'.repeat(96)}`;
        const sanitized = sanitizeFileStem(reservedName);

        expect(Array.from(sanitized)).toHaveLength(100);
        expect(sanitized).toBe(`_CON.${'x'.repeat(95)}`);
    });
});

describe('buildPdfFileStem', () => {
    it('sanitize 済みタイトルと文書生成日時から stem を作る', () => {
        const createdAt = new Date('2026-09-01T05:30:00.000Z');

        expect(buildPdfFileStem({ title: '週次/会議', createdAt })).toBe(
            '週次_会議_20260901-1430',
        );
    });

    it('Timestamp 互換の文書生成日時を使う', () => {
        const createdAt = {
            toDate: () => new Date('2026-09-01T05:30:00.000Z'),
        };

        expect(buildPdfFileStem({ title: '議事録', createdAt })).toBe(
            '議事録_20260901-1430',
        );
    });

    it('Asia/Tokyo の日付境界をファイル名にも使う', () => {
        const createdAt = new Date('2026-12-31T15:05:00.000Z');

        expect(buildPdfFileStem({ title: '', createdAt })).toBe(
            'document_20270101-0005',
        );
    });

    it('生成日時がない場合は現在日時をフォールバックにする', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-01T05:30:00.000Z'));

        try {
            expect(buildPdfFileStem({ title: '議事録' })).toBe(
                '議事録_20260901-1430',
            );
        } finally {
            vi.useRealTimers();
        }
    });
});
