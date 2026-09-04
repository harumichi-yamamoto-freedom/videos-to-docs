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
 * 音声ファイルでも「変換を飛ばして元ファイルをそのまま上げてよい」とは限らない。
 *
 * 🔴 実害 (2026-09-04): 1時間22分・16kHz ステレオの **WAV は 301MB** あり、
 * Storage ルールの 100MB 上限に当たって `storage/unauthorized` になっていた。
 * 「権限がありません」と表示されるので原因が権限だと誤読され、しかも
 * **ビットレートの選択は変換を通らないため一切効かなかった**（64k にしても同じ 301MB が上がる）。
 *
 * 圧縮済み (mp3/m4a/aac/ogg) で上限に収まっているものだけ、そのまま送る。
 * 非圧縮 (wav/flac) や、圧縮済みでも上限を超えるものは変換に回す。
 *
 * 🔴 `size` が読めないファイルは **false**（＝変換に回す）。判定できないものを
 * 「そのまま送ってよい」に丸めると、上限超過が再びゲートの外へ出る。
 */
export const canSendAudioAsIs = (file: File): boolean =>
    isAudioInput(file) && typeof file.size === 'number' && file.size <= GENERATE_MAX_MEDIA_BYTES;
