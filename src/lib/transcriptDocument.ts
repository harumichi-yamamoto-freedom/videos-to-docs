/**
 * 文書が「文字起こし」として扱われるかの判定と、要確認箇所（transcriptReview）の表示用の純関数。
 *
 * 🔴 条件は「音声があるか」ではなく **「本文に時刻リンクがあるか」**。
 *
 * `audioStoragePath` は音声から生成した**すべての**文書に入っている。
 * それを条件に文字起こし用の UI (時刻リンクからの再生・話者改名・従属プレイヤー) を出すと、
 * **既存の議事録文書にもプレイヤーが出て見た目が変わる**。
 * 実際に飛べる先がある文書だけを対象にする (設計 §6.5-3)。
 *
 * 🔴 例外は 1 つだけ（仕様 B3）: 本文編集で時刻リンクが全て消えても、バッチが保存した
 * `transcriptReview` に**再生できる時刻を持つ候補**があれば、再確認用の音声 UI は有効にする。
 * これも「音声があるか」ではなく「飛べる先（候補の時刻）があるか」で決めている。
 *
 * 判定を UI から切り離してあるのは、コンポーネントを import せずに錠をかけられるようにするため
 * (`DocumentDetailPanel` を import すると Firebase の初期化が走る)。
 */
import { parseTranscriptTimestamps } from '@/lib/transcriptMerge';
import type { ReviewCandidate, TranscriptReview } from '@/lib/transcriptReviewContract';

/** 判定に必要な最小限。`Transcription` でも `TranscriptionDocument` でも受けられる */
export interface TranscriptCandidateDocument {
    text?: string;
    transcription?: string;
    audioStoragePath?: string;
    status?: string;
    transcriptReview?: TranscriptReview | null;
}

const bodyOf = (doc: TranscriptCandidateDocument): string | null =>
    typeof doc.text === 'string' ? doc.text
        : typeof doc.transcription === 'string' ? doc.transcription
            : null;

/** 本文に押せる時刻リンク（`#t=秒`）が 1 つでもあるか */
export function hasTranscriptTimestampLinks(doc: TranscriptCandidateDocument | null | undefined): boolean {
    if (!doc) return false;
    const body = bodyOf(doc);
    if (body === null) return false;
    return parseTranscriptTimestamps(body).length > 0;
}

/**
 * 候補の再生に使える開始秒。有限・0 以上・（endSec があれば）start ≤ end のときだけ返す。
 * 🔴 読めない時刻はゼロ秒に置き換えず null（再生・本文移動を無効にするだけで、候補自体は表示する）。
 */
export function reviewCandidateStartSec(
    candidate: Pick<ReviewCandidate, 'startSec' | 'endSec'> | null | undefined,
): number | null {
    if (!candidate) return null;
    const { startSec, endSec } = candidate;
    if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0) return null;
    if (endSec !== undefined) {
        if (typeof endSec !== 'number' || !Number.isFinite(endSec) || endSec < startSec) return null;
    }
    return startSec;
}

/** 保存された候補に、再生へ飛べる時刻を持つものが 1 つでもあるか */
export function reviewHasPlayableTime(review: TranscriptReview | null | undefined): boolean {
    if (!review || !Array.isArray(review.candidates)) return false;
    return review.candidates.some(candidate => reviewCandidateStartSec(candidate) !== null);
}

/**
 * 文字起こし UI（時刻リンク再生・話者改名・従属プレイヤー）を出すか。
 * 本文の時刻リンクが第一条件。無くても、保存済み候補に有効な時刻があれば再確認用に有効化する（仕様 B3）。
 */
export function shouldEnableTranscriptUi(doc: TranscriptCandidateDocument | null | undefined): boolean {
    if (!doc) return false;
    if (hasTranscriptTimestampLinks(doc)) return true;
    return reviewHasPlayableTime(doc.transcriptReview);
}

/**
 * 「要確認箇所」パネルを置く文書か（仕様 B3）。
 * - 処理中の仮本文には置かない（文字起こし結果ではない）
 * - `transcriptReview` を持つ完成文書には置く（候補 0 件・unavailable でも「評価済み／情報なし」を伝えるため）
 * - review の無い旧文書は、本文が文字起こし（時刻リンクあり）のときだけ「信頼度情報がありません」を置く。
 *   🔴 時刻リンクの無い通常の議事録には置かない（既存文書の見た目を変えない）
 */
export function shouldShowTranscriptReviewPanel(doc: TranscriptCandidateDocument | null | undefined): boolean {
    if (!doc) return false;
    if (doc.status === 'processing') return false;
    if (doc.transcriptReview && typeof doc.transcriptReview === 'object') return true;
    return hasTranscriptTimestampLinks(doc);
}

export interface OrderedReviewCandidate {
    candidate: ReviewCandidate;
    /** 保存配列上の元 index（同時刻の安定順・ID 以外の識別に使わない） */
    index: number;
    /** 再生に使える開始秒。無ければ null（カードは末尾へ） */
    startSec: number | null;
}

/**
 * 候補の表示順（仕様 B3）: 時刻あり → 時刻昇順（同時刻は元 index 順）、その後に時刻なしを元 index 順。
 * 保存順に依存せず UI 側で並べ直す。候補の中身は変えない。
 */
export function orderReviewCandidates(
    candidates: readonly ReviewCandidate[] | null | undefined,
): OrderedReviewCandidate[] {
    if (!Array.isArray(candidates)) return [];
    const ordered = candidates
        .filter((candidate): candidate is ReviewCandidate =>
            Boolean(candidate) && typeof candidate === 'object' && typeof candidate.phraseId === 'string')
        .map((candidate, index) => ({ candidate, index, startSec: reviewCandidateStartSec(candidate) }));
    ordered.sort((a, b) => {
        if (a.startSec === null && b.startSec === null) return a.index - b.index;
        if (a.startSec === null) return 1;
        if (b.startSec === null) return -1;
        return a.startSec - b.startSec || a.index - b.index;
    });
    return ordered;
}

/**
 * 段落開始行（1 始まり）→ その段落に属する候補の phraseId（表示順）。
 * 生成時に確定したアンカーだけを使い、行が無い候補は載せない（本文からの推測はしない・仕様 B2）。
 */
export function reviewAnchorsByLine(
    candidates: readonly ReviewCandidate[] | null | undefined,
): Map<number, string[]> {
    const byLine = new Map<number, string[]>();
    for (const { candidate } of orderReviewCandidates(candidates)) {
        const line = candidate.paragraphStartLine;
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue;
        const bucket = byLine.get(line);
        if (bucket) bucket.push(candidate.phraseId);
        else byLine.set(line, [candidate.phraseId]);
    }
    return byLine;
}

// ---------------------------------------------------------------------------
// 本文ハッシュ（仕様 B2）: 表示本文の UTF-8 バイト列の SHA-256（hex）。
// サーバの `sourceTextHashOf`（node:crypto）と同じ規則。一致する間だけ本文の段落バッジ・移動を有効にする。
// ---------------------------------------------------------------------------

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

const toHex = (bytes: Uint8Array): string => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += HEX[bytes[i]];
    return out;
};

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * 純 JS の SHA-256（hex）。`crypto.subtle` が使えない実行環境（非セキュアコンテキスト等）の退避先。
 * 🔴 通常は `hashTranscriptText` を使う。こちらは同期で、大きな本文では主スレッドを数十 ms 使う。
 */
export function sha256Hex(input: string | Uint8Array): string {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const bitLength = bytes.length * 8;
    const paddedLength = (((bytes.length + 9) + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);

    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let t = 0; t < 16; t += 1) words[t] = view.getUint32(offset + t * 4);
        for (let t = 16; t < 64; t += 1) {
            const w15 = words[t - 15];
            const w2 = words[t - 2];
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            words[t] = (words[t - 16] + s0 + words[t - 7] + s1) >>> 0;
        }
        let a = hash[0], b = hash[1], c = hash[2], d = hash[3];
        let e = hash[4], f = hash[5], g = hash[6], h = hash[7];
        for (let t = 0; t < 64; t += 1) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + SHA256_K[t] + words[t]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, hash[i]);
    return toHex(out);
}

const subtleSha256Hex = async (bytes: Uint8Array): Promise<string | null> => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') return null;
    try {
        // 共有バッファに乗らない自前のコピーを渡す（BufferSource の型と実行環境の差を吸収）
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const digest = await subtle.digest('SHA-256', copy);
        return toHex(new Uint8Array(digest));
    } catch {
        return null;
    }
};

/** 同じ本文を複数の表示（パネルと本文）が別々にハッシュしないための小さなキャッシュ */
const HASH_CACHE_LIMIT = 8;
const hashCache = new Map<string, Promise<string>>();

/**
 * 表示本文の SHA-256（hex）。`crypto.subtle` を優先し、無ければ純 JS で計算する。
 * 🔴 呼び出し側は「本文が確定したとき」だけ呼ぶ（編集中の毎キー入力で呼ばない・仕様 B2）。
 */
export function hashTranscriptText(text: string): Promise<string> {
    const cached = hashCache.get(text);
    if (cached) return cached;
    const promise = (async (): Promise<string> => {
        const bytes = new TextEncoder().encode(text);
        return (await subtleSha256Hex(bytes)) ?? sha256Hex(bytes);
    })();
    if (hashCache.size >= HASH_CACHE_LIMIT) {
        const oldest = hashCache.keys().next().value;
        if (oldest !== undefined) hashCache.delete(oldest);
    }
    hashCache.set(text, promise);
    return promise;
}
