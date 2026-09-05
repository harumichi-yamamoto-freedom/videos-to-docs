/**
 * 入力ファイルを「そのまま送れるか / 変換が要るか」で分ける判定。
 *
 * 🔴 フックではなく lib に置いてある。画面側 (`home/page.tsx`) と処理側
 * (`useProcessingWorkflow`) の両方が使うが、画面のテストはフックをモックするため、
 * フックから export するとモックに載せ忘れた瞬間に落ちる（実際に落とした）。
 */
import { getSupportedMediaKind } from '@/components/FileDropZone';
import { GENERATE_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';

export const isAudioInput = (file: File): boolean => getSupportedMediaKind(file) === 'audio';

/**
 * そのまま送ってよい「圧縮済み」音声の拡張子。**明示の許可リスト**。
 *
 * 🔴 ここに無い音声形式は、既知・未知にかかわらず変換に回る (fail-closed)。差集合で
 *    「非圧縮でなければ圧縮済み」と導くと、表に非圧縮の新形式が入った瞬間に
 *    **黙ってそのまま送られる**（＝上限超過がゲートの外へ出る 2026-09-04 の再来）。
 * 🔴 対応形式の一覧そのものは `SUPPORTED_MEDIA_FORMATS` が正。この 2 つのリストは
 *    そこから漏れなく分割していなければならず、`src/hooks/useProcessingWorkflow.test.ts` の
 *    `describe('canSendAudioAsIs')` にある網羅テストが「表の音声形式 == 圧縮済み ∪ 非圧縮」を検査する。
 *    表に音声形式を足したら、どちらかへ必ず追記すること（忘れるとそのテストが落ちる）。
 */
export const COMPRESSED_AUDIO_EXTENSIONS: readonly string[] = ['.mp3', '.m4a', '.aac', '.ogg'];

/** 非圧縮（可逆圧縮を含む）。変換を通さない限りデータ量が下がらない */
export const UNCOMPRESSED_AUDIO_EXTENSIONS: readonly string[] = ['.wav', '.flac'];

const isCompressedAudio = (file: Pick<File, 'name'>): boolean => {
    const lowerName = file.name.toLowerCase();
    return COMPRESSED_AUDIO_EXTENSIONS.some(extension => lowerName.endsWith(extension));
};

/**
 * 音声ファイルでも「変換を飛ばして元ファイルをそのまま上げてよい」とは限らない。
 *
 * 🔴 実害 (2026-09-04): 1時間22分・16kHz ステレオの **WAV は 301MB** あり、
 * 当時の Storage ルールの 100MB 上限に当たって `storage/unauthorized` になっていた
 * （上限はその後 500MB=GENERATE_MAX_MEDIA_BYTES に引き上げ）。
 * 「権限がありません」と表示されるので原因が権限だと誤読され、しかも
 * **ビットレートの選択は変換を通らないため一切効かなかった**（64k にしても同じ 301MB が上がる）。
 *
 * 圧縮済み (mp3/m4a/aac/ogg) で上限に収まっているものだけ、そのまま送る。
 * 非圧縮 (wav/flac) や、圧縮済みでも上限を超えるものは変換に回す。
 * 🔴 上限を 500MB に上げた後は「上限内の WAV」が生まれる。サイズだけで判定すると
 *    その WAV がまた変換を素通りし、ビットレートを下げても効かない状態に戻る。
 *
 * 🔴 `size` が読めないファイルは **false**（＝変換に回す）。判定できないものを
 * 「そのまま送ってよい」に丸めると、上限超過が再びゲートの外へ出る。
 */
export const canSendAudioAsIs = (file: File): boolean =>
    isAudioInput(file)
    && isCompressedAudio(file)
    && typeof file.size === 'number'
    && file.size <= GENERATE_MAX_MEDIA_BYTES;
