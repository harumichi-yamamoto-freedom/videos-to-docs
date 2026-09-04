/**
 * `/api/transcribe/chunk` の入口の錠。
 *
 * ここで守りたいのは主に2つ:
 *  - ゲートの分母 (`audioSec` / `speechSec`) が壊れた値のまま奥へ通らないこと
 *  - サーバ側の注釈をゲートの形へ正規化するとき、**時刻が読めなかったものを黙って 0 で埋めない**こと
 */
import { describe, expect, it } from 'vitest';
import { normalizeAnnotations, validateRequestBody } from './route';
import { quarantineOutOfRangeAnnotations } from '@/lib/transcriptQuality';
import { TRANSCRIBE_CHUNK_MAX_AUDIO_SEC } from '@/lib/transcribeChunkContract';

const validBody = {
    storagePath: 'audio/user-1/chunk-000.mp3',
    fileName: 'chunk-000.mp3',
    mimeType: 'audio/mpeg',
    audioSec: 1500,
    speechSec: 900,
    // 🔴 G6 (最長穴) の入力。省略できない — 省くと G6 が走らず、脱落を誰も検査しないまま合格が返る
    speechIntervals: [[0, 400], [500, 1000]] as Array<[number, number]>,
};

describe('🔴 G8 の隔離が応答に効いている', () => {
    it('範囲外の時刻を持つ注釈は応答から外れる (本文はそのまま)', () => {
        const annotations = [
            { text: '正', startOffsetSec: 0, endOffsetSec: 10, speaker: 'spk:0' },
            { text: '暴走', startOffsetSec: 5, endOffsetSec: 70709.9, speaker: 'spk:1' },
        ];
        const { kept, removed } = quarantineOutOfRangeAnnotations(annotations, 1500);
        expect(kept).toHaveLength(1);
        expect(removed).toHaveLength(1);
    });
});

describe('validateRequestBody', () => {
    it('正しい本文はそのまま通る', () => {
        expect(validateRequestBody(validBody)).toEqual(validBody);
    });

    it.each([
        ['storagePath なし', { ...validBody, storagePath: '' }],
        ['fileName なし', { ...validBody, fileName: '' }],
        ['音声以外の MIME', { ...validBody, mimeType: 'video/mp4' }],
        ['本文がオブジェクトでない', 'not-an-object'],
    ])('%s は 400 で弾く', (_label, body) => {
        expect(() => validateRequestBody(body)).toThrowError();
    });

    describe('🔴 発話区間 (G6 の入力) は形まで検査する', () => {
        it.each([
            ['そもそも無い', (() => { const { speechIntervals: _drop, ...rest } = validBody; return rest; })()],
            ['配列でない', { ...validBody, speechIntervals: 'x' }],
            ['要素が 2 要素でない', { ...validBody, speechIntervals: [[0]] }],
            ['数値でない', { ...validBody, speechIntervals: [['0', '10']] }],
            ['NaN', { ...validBody, speechIntervals: [[0, Number.NaN]] }],
            ['負の開始', { ...validBody, speechIntervals: [[-1, 10]] }],
            ['長さ 0', { ...validBody, speechIntervals: [[10, 10]] }],
            ['終端が逆転', { ...validBody, speechIntervals: [[10, 5]] }],
            ['チャンクの外へ出る', { ...validBody, speechIntervals: [[0, 1502]] }],
            // 🔴 順不同・重なりを通すと、最長穴が実際より短く出て G6 が静かに甘くなる
            ['降順', { ...validBody, speechIntervals: [[500, 600], [0, 100]] }],
            ['重なり', { ...validBody, speechIntervals: [[0, 500], [400, 600]] }],
        ])('%s は 400', (_label, body) => {
            expect(() => validateRequestBody(body)).toThrowError();
        });

        it('空配列は通す (完全に無音のチャンクは実在する)', () => {
            expect(validateRequestBody({ ...validBody, speechIntervals: [] }).speechIntervals).toEqual([]);
        });

        it('隣接する区間 (前の終端 = 次の開始) は通す', () => {
            const body = { ...validBody, speechIntervals: [[0, 500], [500, 900]] };
            expect(validateRequestBody(body).speechIntervals).toEqual([[0, 500], [500, 900]]);
        });
    });

    describe('🔴 ゲートの分母になる値は、壊れたまま奥へ通さない', () => {
        it.each([
            ['audioSec が 0', { ...validBody, audioSec: 0 }],
            ['audioSec が負', { ...validBody, audioSec: -1 }],
            ['audioSec が NaN', { ...validBody, audioSec: Number.NaN }],
            ['audioSec が Infinity', { ...validBody, audioSec: Number.POSITIVE_INFINITY }],
            ['audioSec が文字列', { ...validBody, audioSec: '1500' }],
            ['speechSec が負', { ...validBody, speechSec: -1 }],
            ['speechSec が NaN', { ...validBody, speechSec: Number.NaN }],
            ['speechSec が音声長を超える', { ...validBody, speechSec: 1502 }],
        ])('%s は 400', (_label, body) => {
            expect(() => validateRequestBody(body)).toThrowError();
        });

        it('speechSec = 0 は通す (完全に無音のチャンクは実在する)', () => {
            expect(validateRequestBody({ ...validBody, speechSec: 0 }).speechSec).toBe(0);
        });

        it('speechSec が audioSec ちょうどは通す (境界)', () => {
            expect(validateRequestBody({ ...validBody, speechSec: 1500 }).speechSec).toBe(1500);
        });
    });

    describe('🔴 上限を超える長さは、投げる前に落とす', () => {
        // 上限超の音声は、静かに一部だけ起こされて `completed` が返る失敗様式に入る (設計 §3.3)。
        it('上限ちょうどは通る', () => {
            expect(validateRequestBody({ ...validBody, audioSec: TRANSCRIBE_CHUNK_MAX_AUDIO_SEC }).audioSec)
                .toBe(TRANSCRIBE_CHUNK_MAX_AUDIO_SEC);
        });

        it('上限 + 1 秒は 400', () => {
            expect(() => validateRequestBody({ ...validBody, audioSec: TRANSCRIBE_CHUNK_MAX_AUDIO_SEC + 1 }))
                .toThrowError();
        });

        it('既定のチャンク長 25 分 + オーバーラップ 30 秒 は上限の内側', () => {
            expect(25 * 60 + 30).toBeLessThanOrEqual(TRANSCRIBE_CHUNK_MAX_AUDIO_SEC);
        });
    });
});

describe('normalizeAnnotations', () => {
    it('サーバ側の名前 (startSec/endSec) をゲート側 (startOffsetSec/endOffsetSec) に直す', () => {
        const { annotations, droppedCount } = normalizeAnnotations([
            { text: '銀行', startSec: 3.9, endSec: 4.2, speaker: 'spk:0' },
        ]);
        expect(droppedCount).toBe(0);
        expect(annotations).toEqual([
            { text: '銀行', startOffsetSec: 3.9, endOffsetSec: 4.2, speaker: 'spk:0' },
        ]);
    });

    it('話者が付かなかった注釈は null で通す (silent fail-open の症状を握り潰さない)', () => {
        const { annotations } = normalizeAnnotations([{ text: 'あ', startSec: 1, endSec: 2 }]);
        expect(annotations[0].speaker).toBeNull();
    });

    describe('🔴 時刻が読めなかった注釈は 0 で埋めず、落として数える', () => {
        it.each([
            ['startSec が無い', { text: 'a', endSec: 2, speaker: 'spk:0' }],
            ['endSec が無い', { text: 'a', startSec: 1, speaker: 'spk:0' }],
            ['両方無い', { text: 'a', speaker: 'spk:0' }],
        ])('%s は落とされ、droppedCount に数えられる', (_label, item) => {
            const { annotations, droppedCount } = normalizeAnnotations([item]);
            expect(annotations).toEqual([]);
            expect(droppedCount).toBe(1);
        });

        it('0 で埋めるとカバレッジが壊れる — 落とした側が残らないことを固定する', () => {
            // 0 埋めをすると startOffsetSec: 0 の注釈が生まれ、G8 が「先頭まで起こした」と誤認する。
            const { annotations } = normalizeAnnotations([
                { text: 'a', speaker: 'spk:0' },
                { text: 'b', startSec: 100, endSec: 101, speaker: 'spk:0' },
            ]);
            expect(annotations).toHaveLength(1);
            expect(annotations.some(a => a.startOffsetSec === 0)).toBe(false);
        });

        it('読める注釈と読めない注釈が混ざっても、読める側だけ残る', () => {
            const { annotations, droppedCount } = normalizeAnnotations([
                { text: 'a', startSec: 1, endSec: 2, speaker: 'spk:0' },
                { text: 'b', speaker: 'spk:1' },
                { text: 'c', startSec: 3, endSec: 4, speaker: 'spk:1' },
            ]);
            expect(annotations.map(a => a.text)).toEqual(['a', 'c']);
            expect(droppedCount).toBe(1);
        });
    });

    it('空配列は空配列 (例外にしない)', () => {
        expect(normalizeAnnotations([])).toEqual({ annotations: [], droppedCount: 0 });
    });

    it('text が無い注釈は空文字にする (落とさない — 時刻は生きている)', () => {
        const { annotations, droppedCount } = normalizeAnnotations([{ startSec: 1, endSec: 2 }]);
        expect(droppedCount).toBe(0);
        expect(annotations[0].text).toBe('');
    });
});
