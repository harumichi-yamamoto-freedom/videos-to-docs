/**
 * 音声・動画の**実際の長さ**を、ffmpeg を使わずブラウザのメディア要素だけで測る。
 *
 * 🔴 なぜ要るか（実害・既存バグ）: `estimateAudioSec` は `サイズ × 8 ÷ 画面のビットレート` で
 *    長さを出す。**そのまま送られる入力は画面設定のビットレートで焼かれていない**ので、
 *    元が 192k の m4a を既定 96k の設定で出すと**長さが 2 倍**に見える。
 *    その結果、2 時間の商談が「音声が長すぎます（上限 240 分）」で誤って拒否される。
 *    しかも 400 なので種別が付かず、再変換の導線も出ず、正しい回避策（ビットレートを上げる）は
 *    同じ画面が「この設定は使われません」と言っている＝利用者に打つ手が無い。
 *
 * 🔴 測れないことは正常な結果として扱う。VBR の mp3 は `duration` が `Infinity` になることがあり、
 *    壊れたファイルでは `loadedmetadata` が永久に来ない。どの経路でも `null` を返し、
 *    呼び出し側は従来の推定へ落とす（測定を必須にして新しい失敗経路を作らない）。
 */

/** メタデータの読み込みを待つ上限。ローカルの blob URL なので通常は数十 ms で返る */
export const MEDIA_DURATION_TIMEOUT_MS = 5_000;

/**
 * DOM への依存をここ 1 か所に閉じ込める。テストは差し替えるだけで済み、
 * DOM の無い実行環境（サーバ描画・node のテスト）では自動的に「測れなかった」になる。
 */
export interface MediaDurationEnv {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
    createElement: (kind: 'audio' | 'video') => HTMLMediaElement;
}

const defaultEnv = (): MediaDurationEnv | null => {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return null;
    if (typeof URL.createObjectURL !== 'function') return null;
    return {
        createObjectURL: blob => URL.createObjectURL(blob),
        revokeObjectURL: url => URL.revokeObjectURL(url),
        createElement: kind => document.createElement(kind),
    };
};

/** `duration` は Infinity・NaN・0 以下になり得る。使える値だけ通す */
const usableDuration = (value: number): number | null =>
    Number.isFinite(value) && value > 0 ? value : null;

export interface MeasureMediaDurationOptions {
    env?: MediaDurationEnv | null;
    timeoutMs?: number;
}

/**
 * メディアの長さ（秒）を返す。測れなければ `null`（例外は投げない）。
 * 🔴 `createObjectURL` した URL は **必ず** 解放する。数百MBの Blob が居座る。
 */
export const measureMediaDurationSec = async (
    blob: Blob,
    { env, timeoutMs = MEDIA_DURATION_TIMEOUT_MS }: MeasureMediaDurationOptions = {},
): Promise<number | null> => {
    const resolved = env === undefined ? defaultEnv() : env;
    if (!resolved || !blob || blob.size <= 0) return null;

    let url: string | null = null;
    try {
        url = resolved.createObjectURL(blob);
    } catch {
        return null;
    }

    const element = resolved.createElement(blob.type.startsWith('video/') ? 'video' : 'audio');

    return new Promise<number | null>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (duration: number | null) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            element.removeEventListener('loadedmetadata', onLoaded);
            element.removeEventListener('error', onError);
            try {
                // 読み込みを止めてから解放する。順序を逆にすると読み込み中の参照が残る
                element.removeAttribute('src');
                element.load?.();
            } catch {
                // 解放の妨げにならないよう握りつぶす
            }
            if (url !== null) resolved.revokeObjectURL(url);
            resolve(duration);
        };

        function onLoaded() {
            finish(usableDuration(element.duration));
        }
        function onError() {
            finish(null);
        }

        element.addEventListener('loadedmetadata', onLoaded);
        element.addEventListener('error', onError);
        timer = setTimeout(() => finish(null), timeoutMs);

        try {
            element.preload = 'metadata';
            element.src = url!;
            element.load?.();
        } catch {
            finish(null);
        }
    });
};
