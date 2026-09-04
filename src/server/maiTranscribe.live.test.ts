/**
 * 🔴 実 Azure に対する通し検証。**既定では走らない**（`RUN_LIVE_MAI=1` のときだけ）。
 *
 * 単体テストは口を差し替えているので、`buildMaiDefinition` が実際に受理されるか・
 * 応答が `normalizeMaiPhrases` の想定どおりの形かは通っていない。
 * 仕様に書いてあるパラメータが黙って無視される事故を今日 2 回踏んでいるので
 * （Gemini の `diarization_mode`、OpenRouter の `phraseList`）、実物で確かめる口を残す。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { MaiTranscribeClient, getMaiCredentials } from './maiTranscribe';

const LIVE = process.env.RUN_LIVE_MAI === '1';
const AUDIO = process.env.LIVE_MAI_AUDIO ?? '';

describe.skipIf(!LIVE)('実 Azure（RUN_LIVE_MAI=1 のときだけ）', () => {
    it('3 機能同時で、本文・単語時刻・話者ラベルが揃って返る', async () => {
        const credentials = getMaiCredentials();
        expect(credentials, 'AZURE_SPEECH_ENDPOINT / AZURE_SPEECH_KEY が要る').not.toBeNull();
        expect(existsSync(AUDIO), `LIVE_MAI_AUDIO に音声のパスを渡すこと: ${AUDIO}`).toBe(true);

        const bytes = readFileSync(AUDIO);
        const client = new MaiTranscribeClient(credentials!);
        const result = await client.transcribe({
            bytes, mimeType: 'audio/mpeg', fileName: 'live.mp3', audioSec: 20,
            phraseList: ['アオイ建設'],
        });

        expect(result.status).toBe('completed');
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.transport).toBe('mai_multipart');
        // 🔴 単語時刻: 秒に直っていること（ミリ秒のまま返すと G6 が桁違いに甘くなる）
        expect(result.annotations.length).toBeGreaterThan(0);
        expect(result.annotations[0]!.startSec).toBeLessThan(60);
        expect(result.annotations.at(-1)!.endSec).toBeLessThan(120);
        // 🔴 話者ラベル: `spk:N` の形へ揃っていること（Gemini 側と同じ表記）
        const speakers = new Set(result.annotations.map(a => a.speaker).filter(Boolean));
        expect([...speakers].every(s => /^spk:\d+$/.test(s as string))).toBe(true);
        // 🔴 用語集が効いていること（対照は「青井」になる）
        expect(result.text).toContain('アオイ');
    }, 180_000);
});
