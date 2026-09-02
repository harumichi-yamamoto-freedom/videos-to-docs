import { describe, expect, it } from 'vitest';
import {
    INLINE_REQUEST_BUDGET_BYTES,
    base64LengthForBytes,
    describeInlineBudgetExceeded,
    estimateInlineLimitMinutes,
    parseBitrateKbps,
    selectMediaTransport,
    utf8ByteLength,
} from './inlineMediaBudget';

const MINUTE = 60;
/** CBR MP3 の 1 秒あたりバイト数 */
const bytesPerSecond = (kbps: number) => (kbps * 1000) / 8;

describe('selectMediaTransport (S2-1: inline か Files API かをサイズで決める)', () => {
    it('予算内は inline、予算ちょうども inline (境界は「超えたら迂回」)', () => {
        expect(selectMediaTransport(0)).toBe('inline');
        expect(selectMediaTransport(INLINE_REQUEST_BUDGET_BYTES)).toBe('inline');
    });

    it('1 バイトでも超えたら files_api', () => {
        expect(selectMediaTransport(INLINE_REQUEST_BUDGET_BYTES + 1)).toBe('files_api');
    });

    it('プロンプトのバイト数も予算に含める', () => {
        const base64Length = INLINE_REQUEST_BUDGET_BYTES - 10;
        expect(selectMediaTransport(base64Length, 10)).toBe('inline');
        expect(selectMediaTransport(base64Length, 11)).toBe('files_api');
    });

    it('予算は引数で差し替えられる', () => {
        expect(selectMediaTransport(100, 0, 100)).toBe('inline');
        expect(selectMediaTransport(101, 0, 100)).toBe('files_api');
    });

    it('実害の再現: 192k で 11 分の録音は迂回、128k の 11 分はそのまま送れる', () => {
        const elevenMinutes = 11 * MINUTE;
        const promptBytes = 2_000;
        const at192k = base64LengthForBytes(elevenMinutes * bytesPerSecond(192));
        const at128k = base64LengthForBytes(elevenMinutes * bytesPerSecond(128));

        expect(selectMediaTransport(at192k, promptBytes)).toBe('files_api');
        expect(selectMediaTransport(at128k, promptBytes)).toBe('inline');
    });
});

describe('base64LengthForBytes', () => {
    it('3 バイトごとに 4 文字、端数はパディング込みで 4 文字', () => {
        expect(base64LengthForBytes(0)).toBe(0);
        expect(base64LengthForBytes(1)).toBe(4);
        expect(base64LengthForBytes(3)).toBe(4);
        expect(base64LengthForBytes(4)).toBe(8);
        expect(base64LengthForBytes(6)).toBe(8);
    });

    it('負数は 0 として扱う', () => {
        expect(base64LengthForBytes(-5)).toBe(0);
    });
});

describe('utf8ByteLength', () => {
    it('ASCII は 1 文字 1 バイト、日本語は 1 文字 3 バイト', () => {
        expect(utf8ByteLength('abc')).toBe(3);
        expect(utf8ByteLength('あ')).toBe(3);
        expect(utf8ByteLength('')).toBe(0);
    });
});

describe('parseBitrateKbps', () => {
    it('ffmpeg 形式の k / kbps と bps 表記を kbps に直す', () => {
        expect(parseBitrateKbps('128k')).toBe(128);
        expect(parseBitrateKbps('64kbps')).toBe(64);
        expect(parseBitrateKbps('192K')).toBe(192);
        expect(parseBitrateKbps('128000')).toBe(128);
    });

    it('解釈できない値は null', () => {
        expect(parseBitrateKbps('')).toBeNull();
        expect(parseBitrateKbps('abc')).toBeNull();
        expect(parseBitrateKbps('0k')).toBeNull();
    });
});

describe('estimateInlineLimitMinutes (「約N分を超えると失敗します」の N)', () => {
    it('既定予算では 64k=26分 / 96k=17分 / 128k=13分 / 192k=8分', () => {
        expect(estimateInlineLimitMinutes('64k')).toBe(26);
        expect(estimateInlineLimitMinutes('96k')).toBe(17);
        expect(estimateInlineLimitMinutes('128k')).toBe(13);
        expect(estimateInlineLimitMinutes('192k')).toBe(8);
    });

    it('見積もりは selectMediaTransport と整合する (N 分は inline、N+1 分は迂回)', () => {
        for (const bitrate of ['64k', '96k', '128k', '192k']) {
            const kbps = parseBitrateKbps(bitrate)!;
            const minutes = estimateInlineLimitMinutes(bitrate)!;
            const within = base64LengthForBytes(minutes * MINUTE * bytesPerSecond(kbps));
            const beyond = base64LengthForBytes((minutes + 1) * MINUTE * bytesPerSecond(kbps));
            expect(selectMediaTransport(within), `${bitrate} ${minutes}分`).toBe('inline');
            expect(selectMediaTransport(beyond), `${bitrate} ${minutes + 1}分`).toBe('files_api');
        }
    });

    it('プロンプトが長いぶんだけ短くなる', () => {
        const withoutPrompt = estimateInlineLimitMinutes('128k', 0)!;
        const withLongPrompt = estimateInlineLimitMinutes('128k', 4 * 1024 * 1024)!;
        expect(withLongPrompt).toBeLessThan(withoutPrompt);
    });

    it('解釈できないビットレートは null', () => {
        expect(estimateInlineLimitMinutes('unknown')).toBeNull();
    });
});

describe('describeInlineBudgetExceeded (実行可能な文言)', () => {
    it('ビットレートが分かるときは「約N分」と打てる手を示す', () => {
        const message = describeInlineBudgetExceeded('128k');
        expect(message).toContain('ビットレート 128k では約13分を超えると失敗します');
        expect(message).toContain('ビットレートを下げる');
        expect(message).toContain('ファイルを分割');
        expect(message).not.toBe('動画/音声ファイルが大きすぎます。より小さいファイルを使用してください。');
    });

    it('ビットレートが分からないときはサイズの目安で示す', () => {
        const message = describeInlineBudgetExceeded();
        expect(message).toContain('約12MB');
        expect(message).toContain('ビットレートを下げる');
    });

    it('解釈できないビットレートはサイズの目安に落ちる', () => {
        expect(describeInlineBudgetExceeded('???')).toContain('約12MB');
    });
});
