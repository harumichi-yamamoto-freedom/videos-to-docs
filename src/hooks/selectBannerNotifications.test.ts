import { describe, expect, it } from 'vitest';
import type { SystemNotification } from '@/lib/systemNotifications';
import {
    MAX_BANNER_ITEMS,
    RECENT_BANNER_WINDOW_MS,
    selectBannerNotifications,
} from './useSystemNotifications';

const NOW = Date.parse('2026-09-03T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function notice(id: string, daysAgo: number): SystemNotification {
    return {
        id,
        title: `お知らせ ${id}`,
        body: '本文',
        severity: 'info',
        published: true,
        publishedAt: new Date(NOW - daysAgo * DAY),
        publishedBy: 'admin',
    };
}

describe('selectBannerNotifications（最新 1 件 + 直近 1 週間）', () => {
    it('直近 1 週間のお知らせは全件、新しい順に出す', () => {
        const list = [notice('a', 0), notice('b', 3), notice('c', 6.9), notice('d', 8)];
        expect(selectBannerNotifications(list, [], NOW).map(n => n.id)).toEqual(['a', 'b', 'c']);
    });

    it('最新 1 件は 1 週間より古くても出す（お知らせが途絶えても最後の 1 件は残す）', () => {
        const list = [notice('old', 40), notice('older', 90)];
        expect(selectBannerNotifications(list, [], NOW).map(n => n.id)).toEqual(['old']);
    });

    it('最新 1 件が 1 週間以内なら重複させない', () => {
        const list = [notice('a', 1), notice('b', 2)];
        expect(selectBannerNotifications(list, [], NOW).map(n => n.id)).toEqual(['a', 'b']);
    });

    it('閉じたお知らせは除外し、最新も閉じていれば次に新しいものを最新として扱う', () => {
        const list = [notice('a', 0), notice('b', 20), notice('c', 30)];
        expect(selectBannerNotifications(list, ['a'], NOW).map(n => n.id)).toEqual(['b']);
        expect(selectBannerNotifications(list, ['a', 'b', 'c'], NOW)).toEqual([]);
    });

    it('入力の並びに依存せず publishedAt の新しい順に揃える', () => {
        const list = [notice('b', 3), notice('a', 0), notice('c', 5)];
        expect(selectBannerNotifications(list, [], NOW).map(n => n.id)).toEqual(['a', 'b', 'c']);
    });

    it('境界: ちょうど 7 日前は「直近」に含め、7 日 + 1ms 前は含めない', () => {
        const exactly = { ...notice('x', 0), publishedAt: new Date(NOW - RECENT_BANNER_WINDOW_MS) };
        const justOutside = { ...notice('y', 0), publishedAt: new Date(NOW - RECENT_BANNER_WINDOW_MS - 1) };
        const latest = notice('latest', 0);
        expect(selectBannerNotifications([latest, exactly, justOutside], [], NOW).map(n => n.id)).toEqual(['latest', 'x']);
    });

    it('直近 1 週間に上限を超えて投入されても MAX_BANNER_ITEMS 件までに抑える', () => {
        const list = Array.from({ length: MAX_BANNER_ITEMS + 5 }, (_, i) => notice(`n${i}`, i * 0.1));
        expect(selectBannerNotifications(list, [], NOW)).toHaveLength(MAX_BANNER_ITEMS);
    });

    it('0 件なら空', () => {
        expect(selectBannerNotifications([], [], NOW)).toEqual([]);
    });
});
