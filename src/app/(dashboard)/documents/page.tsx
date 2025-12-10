'use client';

import React, { useState } from 'react';
import { DocumentListSidebar } from '@/components/DocumentListSidebar';
import { DocumentDetailPanel } from '@/components/DocumentDetailPanel';
import { Transcription } from '@/lib/firestore';
import { List } from 'lucide-react';

export default function DocumentsPage() {
  const [selectedDocuments, setSelectedDocuments] = useState<Transcription[]>([]);
  const [documentUpdateTrigger, setDocumentUpdateTrigger] = useState(0);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  const handleDocumentClick = (transcription: Transcription) => {
    if (!isMultiSelectMode) {
      // 単一選択モード: 1つだけ選択
      setSelectedDocuments([transcription]);
    } else {
      // 複数選択モード: 最大3つまで選択
      setSelectedDocuments(prev => {
        const isAlreadySelected = prev.some(doc => doc.id === transcription.id);
        if (isAlreadySelected) {
          // 既に選択されている場合は解除
          return prev.filter(doc => doc.id !== transcription.id);
        } else {
          // まだ選択されていない場合は追加（最大3つまで）
          if (prev.length >= 3) {
            alert('最大3つまで選択できます');
            return prev;
          }
          return [...prev, transcription];
        }
      });
    }
  };

  const handleTitleUpdate = async (docId: string, newTitle: string) => {
    // モック: ローカルで更新
    await new Promise(resolve => setTimeout(resolve, 300));
    setDocumentUpdateTrigger(prev => prev + 1);
    setSelectedDocuments(prev =>
      prev.map(doc => (doc.id === docId ? { ...doc, title: newTitle } : doc))
    );
  };

  const handleContentUpdate = async (docId: string, newContent: string) => {
    // モック: ローカルで更新
    await new Promise(resolve => setTimeout(resolve, 300));
    setDocumentUpdateTrigger(prev => prev + 1);
    setSelectedDocuments(prev =>
      prev.map(doc => (doc.id === docId ? { ...doc, text: newContent } : doc))
    );
  };

  const toggleMultiSelectMode = () => {
    if (isMultiSelectMode) {
      // 複数選択モードを解除する場合、選択を1つだけに戻す
      if (selectedDocuments.length > 1) {
        setSelectedDocuments([selectedDocuments[0]]);
      }
    }
    setIsMultiSelectMode(!isMultiSelectMode);
  };

  return (
    <div className="max-w-7xl mx-auto">
      {/* 複数選択モード切替ボタン */}
      <div className="mb-4 flex justify-end">
        <button
          onClick={toggleMultiSelectMode}
          className={`px-6 py-3 rounded-xl font-semibold shadow-lg transform transition-all duration-200 flex items-center space-x-2 ${
            isMultiSelectMode
              ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-700 hover:to-pink-700 scale-105'
              : 'bg-white text-gray-700 border-2 border-gray-200 hover:border-purple-300'
          }`}
        >
          <List className="w-5 h-5" />
          <span>{isMultiSelectMode ? '単一選択モード' : '複数選択モード（最大3つ）'}</span>
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* 左サイドバー: 文書一覧 */}
        <div className="lg:w-3/10 w-full">
          <div className="bg-white rounded-xl shadow-lg overflow-hidden h-[calc(100vh-180px)] min-h-[532px]">
            <DocumentListSidebar
              onDocumentClick={handleDocumentClick}
              updateTrigger={documentUpdateTrigger}
              selectedDocumentIds={selectedDocuments.map(doc => doc.id!)}
              isMultiSelectMode={isMultiSelectMode}
            />
          </div>
        </div>

        {/* 右パネル: 文書詳細表示 */}
        <div className="lg:w-7/10 w-full h-[calc(100vh-180px)] min-h-[532px]">
          {selectedDocuments.length === 0 ? (
            <div className="bg-white rounded-xl shadow-lg h-full flex items-center justify-center">
              <div className="text-center text-gray-400">
                <List className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">文書を選択してください</p>
                <p className="text-sm mt-2">
                  {isMultiSelectMode
                    ? '複数選択モードで最大3つまで選択できます'
                    : '左側の一覧から文書を選択してください'}
                </p>
              </div>
            </div>
          ) : selectedDocuments.length === 1 ? (
            // 単一選択: 全幅表示
            <div className="h-full">
              <DocumentDetailPanel
                document={selectedDocuments[0]}
                onTitleUpdate={(newTitle) => handleTitleUpdate(selectedDocuments[0].id!, newTitle)}
                onContentUpdate={(newContent) =>
                  handleContentUpdate(selectedDocuments[0].id!, newContent)
                }
                compactMode={false}
              />
            </div>
          ) : (
            // 複数選択: 3分割レイアウト
            <div className="grid grid-cols-2 grid-rows-2 gap-4 h-full">
              {/* 左上: 縦1×横0.5 */}
              <div className="row-span-2">
                <DocumentDetailPanel
                  document={selectedDocuments[0]}
                  onTitleUpdate={(newTitle) => handleTitleUpdate(selectedDocuments[0].id!, newTitle)}
                  onContentUpdate={(newContent) =>
                    handleContentUpdate(selectedDocuments[0].id!, newContent)
                  }
                  compactMode={true}
                />
              </div>

              {/* 右上: 縦0.5×横1 */}
              {selectedDocuments[1] && (
                <div className="row-span-1">
                  <DocumentDetailPanel
                    document={selectedDocuments[1]}
                    onTitleUpdate={(newTitle) => handleTitleUpdate(selectedDocuments[1].id!, newTitle)}
                    onContentUpdate={(newContent) =>
                      handleContentUpdate(selectedDocuments[1].id!, newContent)
                    }
                    compactMode={true}
                  />
                </div>
              )}

              {/* 右下: 縦0.5×横1 */}
              {selectedDocuments[2] && (
                <div className="row-span-1">
                  <DocumentDetailPanel
                    document={selectedDocuments[2]}
                    onTitleUpdate={(newTitle) => handleTitleUpdate(selectedDocuments[2].id!, newTitle)}
                    onContentUpdate={(newContent) =>
                      handleContentUpdate(selectedDocuments[2].id!, newContent)
                    }
                    compactMode={true}
                  />
                </div>
              )}

              {/* 空のスペース（2つ目または3つ目が選択されていない場合） */}
              {!selectedDocuments[1] && (
                <div className="row-span-1 bg-white rounded-xl shadow-lg border-2 border-dashed border-gray-200 flex items-center justify-center">
                  <p className="text-sm text-gray-400">2つ目の文書を選択</p>
                </div>
              )}
              {!selectedDocuments[2] && (
                <div className="row-span-1 bg-white rounded-xl shadow-lg border-2 border-dashed border-gray-200 flex items-center justify-center">
                  <p className="text-sm text-gray-400">3つ目の文書を選択</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


