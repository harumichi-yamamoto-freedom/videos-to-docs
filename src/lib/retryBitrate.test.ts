import { describe, expect, it } from 'vitest';
import type { FileProcessingStatus } from '@/types/processing';
import { GENERATE_SYNC_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';
import { AZURE_BATCH_MAX_AUDIO_SEC } from '@/lib/azureBatchContract';
import {
    formatBitrateLabel,
    planRetryConversion,
    retryPlanFromStatus,
    RETRY_SIZE_MARGIN,
    type RetryConversionInput,
} from './retryBitrate';

const MB = 1024 * 1024;

const plan = (overrides: Partial<RetryConversionInput> = {}) => planRetryConversion({
    currentBitrate: '96k',
    actualBytes: 600 * MB,
    limitBytes: 500 * MB,
    wasConverted: true,
    ...overrides,
});

describe('planRetryConversion: 変換由来のデータを下げる', () => {
    it('推定サイズが余裕つきの予算に収まる、最も高い候補を選ぶ', () => {
        // 96k で 600MB → 64k なら 400MB。予算 500MB/1.05 = 約476MB に収まる
        expect(plan({ currentBitrate: '96k', actualBytes: 600 * MB }))
            .toEqual({ kind: 'lower_bitrate', bitrate: '64k' });

        // 192k で 600MB → 128k で 400MB（収まる）。96k まで下げない
        expect(plan({ currentBitrate: '192k', actualBytes: 600 * MB }))
            .toEqual({ kind: 'lower_bitrate', bitrate: '128k' });
    });

    it('🔴 5% の余裕を使う。上限には収まるが余裕が無い候補は選ばない', () => {
        // 128k で 660MB → 96k の推定は 495MB。上限 500MB には収まるが予算 (500/1.05≒476MB) は超える。
        // 余裕を見ないと 96k を選び、見積り誤差で再び失敗する。余裕を見るので 64k (330MB) まで下げる
        expect(plan({ currentBitrate: '128k', actualBytes: 660 * MB, limitBytes: 500 * MB }))
            .toEqual({ kind: 'lower_bitrate', bitrate: '64k' });

        // 予算そのものに収まる大きさなら 96k が採れる（境界の反対側）
        const fitsWithMargin = Math.floor((500 * MB / RETRY_SIZE_MARGIN) * (128 / 96));
        expect(plan({ currentBitrate: '128k', actualBytes: fitsWithMargin, limitBytes: 500 * MB }))
            .toEqual({ kind: 'lower_bitrate', bitrate: '96k' });
    });

    it('どの候補も予算に収まらないときは最下位候補まで下げる', () => {
        expect(plan({ currentBitrate: '192k', actualBytes: 50_000 * MB }))
            .toEqual({ kind: 'lower_bitrate', bitrate: '64k' });
    });

    it('🔴 現在が最下位なら手が無いことを返す（下げられない提案を出さない）', () => {
        expect(plan({ currentBitrate: '64k' }))
            .toEqual({ kind: 'unavailable', reason: 'already_lowest' });
    });

    it('一覧に無いビットレートは kbps で位置を決める', () => {
        // 160k は一覧に無い。128k 以下が候補になり、160k→128k で予算に収まる
        expect(plan({ currentBitrate: '160k', actualBytes: 500 * MB }))
            .toEqual({ kind: 'lower_bitrate', bitrate: '128k' });
        // 32k より低い候補は無い
        expect(plan({ currentBitrate: '32k' }))
            .toEqual({ kind: 'unavailable', reason: 'already_lowest' });
    });

    it('ビットレートやサイズが読めないときは最下位まで下げる（下げない側に丸めない）', () => {
        expect(plan({ currentBitrate: '???' })).toEqual({ kind: 'lower_bitrate', bitrate: '64k' });
        expect(plan({ actualBytes: 0 })).toEqual({ kind: 'lower_bitrate', bitrate: '64k' });
    });
});

describe('planRetryConversion: 変換を通っていなかったデータ', () => {
    /**
     * 🔴 実害 (2026-09-04): そのまま送られた音声はビットレートを下げても効かない。
     *    打つ手は「下げる」ではなく「変換を通すこと」そのもの。
     */
    it('予算に収まるなら現在のビットレートのまま変換し直す', () => {
        // 上限 500MB・4時間の上界でも 96k は 172.8MB で収まる
        expect(plan({ wasConverted: false, currentBitrate: '96k' }))
            .toEqual({ kind: 'convert_as_is_input', bitrate: '96k' });
    });

    /**
     * 🔴 実害: 4時間・192k の mp3 (約345MB) はアップロード(500MB)を通り、文書生成(200MB)で 413。
     *    ここで「現在の 192k のまま変換」を返すと、同じ大きさに再エンコードするだけなので
     *    数百MBの再変換と再アップロードを待たされた末にもう一度落ちる。
     *    元のビットレートは分からないので、**長さから出力サイズを見積もって**下げ先を決める。
     */
    it('🔴 現在のビットレートで変換しても収まらないなら、収まるところまで下げる', () => {
        const plan200 = plan({
            wasConverted: false,
            currentBitrate: '192k',
            actualBytes: 345_600_000,
            limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES,
        });

        // 4時間の上界で 192k=345.6MB・128k=230.4MB は予算(190.5MiB)超、96k=172.8MB が収まる
        expect(plan200).toEqual({ kind: 'convert_as_is_input', bitrate: '96k' });
        const chosenKbps = Number.parseInt((plan200 as { bitrate: string }).bitrate, 10);
        expect((chosenKbps * 1000 / 8) * AZURE_BATCH_MAX_AUDIO_SEC)
            .toBeLessThanOrEqual(GENERATE_SYNC_MAX_MEDIA_BYTES);
    });

    it('実測の長さが分かっていればそれで見積もる（上界より緩くなる）', () => {
        // 同じ 192k・200MB でも、実際が 30 分なら 192k のまま (43.2MB) で収まる
        expect(plan({
            wasConverted: false,
            currentBitrate: '192k',
            limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES,
            knownDurationSec: 30 * 60,
        })).toEqual({ kind: 'convert_as_is_input', bitrate: '192k' });
    });

    it('どの候補も収まらなければ最下位で変換する', () => {
        expect(plan({
            wasConverted: false,
            currentBitrate: '192k',
            limitBytes: 1024,
        })).toEqual({ kind: 'convert_as_is_input', bitrate: '64k' });
    });

    it('最下位のビットレートでも「変換する」手は残る', () => {
        expect(plan({ wasConverted: false, currentBitrate: '64k' }))
            .toEqual({ kind: 'convert_as_is_input', bitrate: '64k' });
    });
});

describe('retryPlanFromStatus', () => {
    const createStatus = (overrides: Partial<FileProcessingStatus> = {}): FileProcessingStatus => ({
        fileId: 'f1',
        fileName: '会議音声.m4a',
        status: 'error',
        phase: 'uploading',
        audioConversionProgress: 0,
        transcriptionCount: 0,
        totalTranscriptions: 1,
        completedPromptIds: [],
        promptStates: {},
        savePendingPromptIds: [],
        segmentDuration: 30,
        segments: [],
        completedSegmentIndices: [],
        failureKind: 'too_large',
        sizeFailure: { bytes: 600 * MB, bitrate: '96k', wasConverted: true, limitBytes: 500 * MB },
        ...overrides,
    });

    it('サイズ超過の失敗からは計画が出る', () => {
        expect(retryPlanFromStatus(createStatus()))
            .toEqual({ kind: 'lower_bitrate', bitrate: '64k' });
    });

    it('サイズ以外の失敗では計画を出さない', () => {
        expect(retryPlanFromStatus(createStatus({ failureKind: undefined }))).toBeNull();
    });

    it('実測値が残っていない失敗では計画を出さない（当て推量で下げない）', () => {
        expect(retryPlanFromStatus(createStatus({ sizeFailure: undefined }))).toBeNull();
    });

    /**
     * 🔴 そのまま送られた入力は元のビットレートが分からないので、実測の長さがあるかどうかで
     *    下げ先が変わる。実測を無視して 4 時間の上界を使い続けると、必要以上に下げる。
     */
    it('実測の長さが記録されていれば、上界ではなくそれで見積もる', () => {
        const base = {
            bytes: 300 * MB,
            bitrate: '192k',
            wasConverted: false,
            limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES,
        };

        // 実測 30 分なら 192k のまま（43.2MB）で収まる
        expect(retryPlanFromStatus(createStatus({ sizeFailure: { ...base, durationSec: 1800 } })))
            .toEqual({ kind: 'convert_as_is_input', bitrate: '192k' });

        // 実測が無ければ 4 時間の上界で見積もるので 96k まで下がる
        expect(retryPlanFromStatus(createStatus({ sizeFailure: base })))
            .toEqual({ kind: 'convert_as_is_input', bitrate: '96k' });
    });

    it('🔴 予算は「実際に破った上限」で測る（呼び出し側が何も渡さなくても）', () => {
        // 同じ入力でも、破った上限が違えば下げ先が変わる
        const brokeUploadLimit = createStatus({
            sizeFailure: { bytes: 300 * MB, bitrate: '192k', wasConverted: true, limitBytes: 500 * MB },
        });
        expect(retryPlanFromStatus(brokeUploadLimit))
            .toEqual({ kind: 'lower_bitrate', bitrate: '128k' });

        const brokeSyncLimit = createStatus({
            sizeFailure: { bytes: 300 * MB, bitrate: '192k', wasConverted: true, limitBytes: 100 * MB },
        });
        expect(retryPlanFromStatus(brokeSyncLimit))
            .toEqual({ kind: 'lower_bitrate', bitrate: '64k' });
    });

    /**
     * 🔴 実害の再現 (並行レーンが同期文書生成の上限を 200MB へ下げたことによる):
     *    4 時間・192k の録音 ≈ 345MB。アップロード (500MB) は通るが文書生成が 200MB 超で 413。
     *    500MB を予算に使うと 128k (推定 230MB) を選び、**もう一度 200MB を超えて落ちる**。
     *    そのたびに数百MBの再変換と再アップロードが走る。
     */
    it('🔴 200MB で落ちた失敗には、200MB に収まる下げ先を一度で選ぶ', () => {
        const fourHoursAt192k = (192 * 1000 / 8) * (4 * 60 * 60); // 345,600,000 bytes
        const status = createStatus({
            sizeFailure: {
                bytes: fourHoursAt192k,
                bitrate: '192k',
                wasConverted: true,
                limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES,
            },
        });

        const plan = retryPlanFromStatus(status);

        expect(plan).toEqual({ kind: 'lower_bitrate', bitrate: '96k' });
        // 選んだ下げ先の推定サイズが、破った上限に実際に収まっている
        const chosenKbps = Number.parseInt((plan as { bitrate: string }).bitrate, 10);
        const estimated = fourHoursAt192k * (chosenKbps / 192);
        expect(estimated).toBeLessThanOrEqual(GENERATE_SYNC_MAX_MEDIA_BYTES);
    });
});

describe('formatBitrateLabel', () => {
    it('一覧にある値は表示名にする', () => {
        expect(formatBitrateLabel('64k')).toBe('64 kbps');
        expect(formatBitrateLabel('192k')).toBe('192 kbps');
    });

    it('一覧に無い値はそのまま出す', () => {
        expect(formatBitrateLabel('160k')).toBe('160k');
    });
});
