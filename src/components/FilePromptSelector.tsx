'use client';

import React from 'react';
import { CheckSquare, Square } from 'lucide-react';
import { FileWithPrompts } from '@/types/processing';
import { Prompt } from '@/lib/prompts';
import { getGeminiModelLabel } from '@/constants/geminiModels';

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
  if (selectedFiles.length === 0 || availablePrompts.length === 0) {
    return null;
  }

  return (
    <div className="mt-6 space-y-4">
      <h3 className="text-lg font-medium text-gray-900">
        ファイルごとのプロンプト設定
      </h3>
      <p className="text-xs text-amber-600 -mt-2">
        ※ Gemini 3.1 Pro は処理に時間がかかる場合があります。速度を重視する場合は Gemini 3 Pro もお試しください。
      </p>
      {selectedFiles.map((fileWithPrompts, fileIndex) => (
        <div key={fileIndex} className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-900 mb-3">
            📄 {fileWithPrompts.file.name}
          </p>
          <div className="space-y-1">
            {availablePrompts.map(prompt => (
              <div
                key={prompt.id}
                className="flex items-center space-x-2 cursor-pointer hover:bg-gray-100 p-2 rounded"
                onClick={() => onToggleFilePrompt(fileIndex, prompt.id!)}
              >
                {fileWithPrompts.selectedPromptIds.includes(prompt.id!) ? (
                  <CheckSquare className="w-4 h-4 text-blue-600" />
                ) : (
                  <Square className="w-4 h-4 text-gray-400" />
                )}
                <div className="flex flex-col">
                  <span className="text-sm text-gray-700">{prompt.name}</span>
                  <span className="text-[11px] text-gray-500">
                    {getGeminiModelLabel(prompt.model)}
                  </span>
                </div>
                <span className="text-xs text-gray-500 ml-auto">
                  ({fileWithPrompts.selectedPromptIds.includes(prompt.id!) ? '選択中' : '未選択'})
                </span>
              </div>
            ))}
          </div>
          {fileWithPrompts.selectedPromptIds.length === 0 && (
            <p className="text-xs text-red-600 mt-2">
              ⚠️ 最低1つのプロンプトを選択してください
            </p>
          )}
        </div>
      ))}
    </div>
  );
};

