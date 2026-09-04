'use client';

import React, { useId } from 'react';
import { FileWithPrompts } from '@/types/processing';
import { Prompt } from '@/lib/prompts';
import { getGeminiModelLabel } from '@/constants/geminiModels';
import { isTranscriptPrompt, TRANSCRIPT_PREVIEW_NOTICE } from '@/lib/transcriptPrompt';

interface FilePromptSelectorProps {
  selectedFiles: FileWithPrompts[];
  availablePrompts: Prompt[];
  onToggleFilePrompt: (fileIndex: number, promptId: string) => void;
}

export const FilePromptSelector: React.FC<FilePromptSelectorProps> = ({
  selectedFiles,
  availablePrompts,
  onToggleFilePrompt,
}) => {
  const groupId = useId();

  if (selectedFiles.length === 0 || availablePrompts.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4">
      <h3 className="text-lg font-medium text-gray-900">
        ファイルごとのプロンプト設定
      </h3>
      {selectedFiles.map((fileWithPrompts, fileIndex) => (
        <fieldset
          key={`${groupId}-${fileIndex}`}
          className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 p-4"
        >
          <legend className="px-1 text-sm font-medium text-gray-900">
            {fileWithPrompts.file.name}
          </legend>
          <div className="space-y-1">
            {availablePrompts.map(prompt => {
              const checkboxId = `${groupId}-${fileIndex}-${prompt.id}`;
              const isSelected = fileWithPrompts.selectedPromptIds.includes(prompt.id!);

              return (
                <label
                  key={prompt.id}
                  htmlFor={checkboxId}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-2 py-1 hover:bg-gray-100 focus-within:ring-2 focus-within:ring-blue-500"
                >
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleFilePrompt(fileIndex, prompt.id!)}
                    className="h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-gray-800">{prompt.name}</span>
                    <span className="text-xs text-gray-600">
                      {getGeminiModelLabel(prompt.model)}
                    </span>
                    {/* 🔴 主エンジンが public preview であることを、選ぶ場所で断る (設計 §3.7) */}
                    {isTranscriptPrompt(prompt) && (
                      <span className="mt-0.5 text-xs text-amber-800">
                        {TRANSCRIPT_PREVIEW_NOTICE}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          {fileWithPrompts.selectedPromptIds.length === 0 && (
            <p className="mt-2 text-[13px] text-red-700" role="alert">
              このファイルには、最低1つのプロンプトを選択してください。
            </p>
          )}
        </fieldset>
      ))}
    </section>
  );
};
