import { SegmentStatus } from '@/types/processing';

/**
 * 全体の進捗を計算するヘルパー関数
 * 各セグメントの進捗を合計して平均を返す
 */
export const calculateOverallProgress = (segments: SegmentStatus[]): number => {
    if (segments.length === 0) return 0;

    // 各セグメントの進捗を合計（小数点以下も保持）
    const totalProgress = segments.reduce((sum, segment) => {
        if (segment.status === 'completed') {
            return sum + 100;
        } else if (segment.status === 'converting') {
            return sum + segment.progress;
        } else {
            return sum + 0; // pending or error
        }
    }, 0);

    // 平均進捗を計算（小数点1桁で四捨五入）
    const avgProgress = totalProgress / segments.length;
    const result = Math.round(avgProgress * 10) / 10;

    return result;
};

