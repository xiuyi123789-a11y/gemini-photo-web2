
import React, { useMemo, useState } from 'react';
import { analyzeImages } from '../services/replicateService';
import { addAnalysisResultToKB } from '../services/knowledgeBaseService';
import { AnalysisResult, ImageFile } from '../types';
import { FileUpload } from './FileUpload';
import { LoadingSpinner } from './LoadingSpinner';
import { BookOpenIcon } from './IconComponents';
import { logOperation } from '../services/errorNotebookService';

interface AnalysisViewProps {
  onAnalysisComplete: (result: AnalysisResult[]) => void;
}

const FormattedMarkdownResultDisplay: React.FC<{ results: AnalysisResult[] }> = ({ results }) => {
    const parseSections = (analysis: string): Array<{ title: string; content: string }> => {
        const lines = analysis.split(/\r?\n/);
        const sections: Array<{ title: string; contentLines: string[] }> = [];
        let current: { title: string; contentLines: string[] } | null = null;

        const commit = () => {
            if (!current) return;
            const content = current.contentLines.join('\n').trim();
            if (current.title.trim() && content) {
                sections.push({ title: current.title.trim(), contentLines: content.split('\n') });
            }
            current = null;
        };

        for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            const bracketHeaderMatch = line.trim().match(/^(?:\d+\.\s*)?【\s*(.+?)\s*】\s*$/);
            const boldHeaderMatch = line.trim().match(/^\*\*\s*(?:\d+\.\s*)?(.+?)\s*\*\*\s*$/);
            const mdHeaderMatch = line.trim().match(/^#{1,6}\s*(?:\d+\.\s*)?(.+?)\s*$/);
            const headerText = bracketHeaderMatch?.[1] || boldHeaderMatch?.[1] || mdHeaderMatch?.[1];

            if (headerText) {
                commit();
                const normalized = headerText.replace(/[：:]\s*$/, '').trim();
                current = { title: normalized, contentLines: [] };
                continue;
            }

            if (!current) continue;
            current.contentLines.push(rawLine);
        }

        commit();
        return sections.map(s => ({ title: s.title, content: s.contentLines.join('\n').trim() }));
    };

    const [modeByIndex, setModeByIndex] = useState<Record<number, 'full' | 'split'>>({});
    const [activeSectionByIndex, setActiveSectionByIndex] = useState<Record<number, string>>({});

    const sectionsByIndex = useMemo(() => {
        return results.map(r => parseSections(r.analysis || ''));
    }, [results]);

    return (
        <div className="space-y-6">
            {results.map((res, idx) => (
                <div key={idx} className="bg-white/80 p-6 rounded-2xl text-sm text-slate-700 border border-slate-200 shadow-sm">
                    <h4 className="text-lg font-bold text-slate-900 mb-3 border-b border-slate-200 pb-2 flex justify-between">
                        <span>📄 {res.fileName}</span>
                        <span className="text-slate-500 font-normal text-xs">{new Date(res.timestamp || '').toLocaleString()}</span>
                    </h4>
                    <div className="flex flex-wrap gap-2 mb-4">
                        <button
                            onClick={() => {
                                setModeByIndex(prev => ({ ...prev, [idx]: 'full' }));
                                logOperation('analysis_result_view_mode', { fileName: res.fileName, mode: 'full' });
                            }}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all border ${
                                (modeByIndex[idx] || 'full') === 'full'
                                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900'
                            }`}
                        >
                            完整复刻
                        </button>
                        <button
                            onClick={() => {
                                const sections = sectionsByIndex[idx] || [];
                                if (sections.length === 0) return;
                                setModeByIndex(prev => ({ ...prev, [idx]: 'split' }));
                                const firstTitle = sections[0]?.title || '';
                                if (firstTitle) {
                                    setActiveSectionByIndex(prev => ({ ...prev, [idx]: prev[idx] || firstTitle }));
                                }
                                logOperation('analysis_result_view_mode', { fileName: res.fileName, mode: 'split' });
                            }}
                            disabled={(sectionsByIndex[idx] || []).length === 0}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all border disabled:opacity-50 disabled:cursor-not-allowed ${
                                (modeByIndex[idx] || 'full') === 'split'
                                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900'
                            }`}
                        >
                            分区拆解
                        </button>
                    </div>

                    {(modeByIndex[idx] || 'full') === 'split' && (sectionsByIndex[idx] || []).length > 0 && (
                        <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar mb-4">
                            {(sectionsByIndex[idx] || []).map(section => {
                                const active = (activeSectionByIndex[idx] || (sectionsByIndex[idx]?.[0]?.title || '')) === section.title;
                                return (
                                    <button
                                        key={section.title}
                                        onClick={() => {
                                            setActiveSectionByIndex(prev => ({ ...prev, [idx]: section.title }));
                                            logOperation('analysis_result_section_select', { fileName: res.fileName, section: section.title });
                                        }}
                                        className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all border ${
                                            active
                                                ? 'bg-blue-600 text-white border-blue-600'
                                                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-900'
                                        }`}
                                        title={section.title}
                                    >
                                        {section.title}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <div className="whitespace-pre-wrap font-sans leading-relaxed">
                        {(modeByIndex[idx] || 'full') === 'split' && (sectionsByIndex[idx] || []).length > 0
                            ? (sectionsByIndex[idx].find(s => s.title === (activeSectionByIndex[idx] || sectionsByIndex[idx][0].title))?.content || res.analysis)
                            : res.analysis}
                    </div>
                    {res.error && <p className="text-red-700 mt-2 text-xs">⚠️ 此文件解析遇到错误</p>}
                </div>
            ))}
        </div>
    );
};

export const AnalysisView: React.FC<AnalysisViewProps> = ({ onAnalysisComplete }) => {
  const [imageFiles, setImageFiles] = useState<ImageFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingToKB, setIsSavingToKB] = useState(false);
  const [kbSaveSuccess, setKbSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[] | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number; currentFileName?: string } | null>(null);

  const handleFileSelect = (files: ImageFile[]) => {
    setImageFiles(files);
    setAnalysisResults(null);
    setError(null);
    setKbSaveSuccess(false);
    setProgress(null);
  };

  const handleAnalyze = async () => {
    if (imageFiles.length === 0) {
      setError('请至少上传一张图片。');
      return;
    }
    const start = performance.now();
    setIsLoading(true);
    setError(null);
    setAnalysisResults(null);
    setKbSaveSuccess(false);
    setProgress({ completed: 0, total: imageFiles.length });

    try {
      const results = await analyzeImages(imageFiles.map(f => f.file), {
        onProgress: setProgress,
        retry: { retries: 3, minDelayMs: 800, maxDelayMs: 8000, timeoutMs: 180000 }
      });
      setAnalysisResults(results);
      logOperation('analysis_run_success', { count: results.length, elapsedMs: Math.round(performance.now() - start) });
    } catch (e: any) {
      setError(e.message || '发生未知错误。');
      logOperation('analysis_run_failed', { message: e?.message || 'unknown', elapsedMs: Math.round(performance.now() - start) });
    } finally {
      setIsLoading(false);
      setProgress(null);
    }
  };
  
  const handleConfirm = () => {
    if (analysisResults) {
        onAnalysisComplete(analysisResults);
    }
  };

  const handleSaveToKB = async () => {
        if (!analysisResults || analysisResults.length === 0) return;
        
        const start = performance.now();
        setIsSavingToKB(true);
        try {
            // Save each result individually
            for (const result of analysisResults) {
                await addAnalysisResultToKB(result, imageFiles);
            }
            setKbSaveSuccess(true);
            setTimeout(() => setKbSaveSuccess(false), 3000);
            logOperation('analysis_save_to_kb_success', { count: analysisResults.length, elapsedMs: Math.round(performance.now() - start) });
        } catch (e) {
            console.error("Failed to save to KB", e);
            setError("保存到知识库失败，请重试。");
            logOperation('analysis_save_to_kb_failed', { message: (e as any)?.message || 'unknown', elapsedMs: Math.round(performance.now() - start) });
        } finally {
            setIsSavingToKB(false);
        }
    };

    return (
        <div>
            <div className="text-center mb-8">
                <h2 className="text-3xl font-extrabold text-slate-900 mb-2">智能解析</h2>
                <p className="text-slate-600">上传图片，利用 OpenAI GPT-4o-mini 模型进行深度视觉分析。</p>
            </div>

            {imageFiles.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-bold text-slate-800 mb-3 ml-1">已上传预览</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {imageFiles.map((imageFile, index) => (
              <img key={index} src={imageFile.preview} alt={`preview ${index}`} className="w-full h-full object-cover rounded-2xl border border-slate-200 aspect-square shadow-sm" />
            ))}
          </div>
        </div>
      )}

      <FileUpload onFilesSelected={handleFileSelect} multiple={true} />
      
      {error && <p className="text-red-700 mt-4 text-center bg-red-50 py-2 rounded-lg border border-red-200">{error}</p>}
      
      <div className="mt-8 flex justify-center">
        <button
          onClick={handleAnalyze}
          disabled={isLoading || imageFiles.length === 0}
          className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-10 rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-[1.02] shadow-sm"
        >
          {isLoading
            ? `AI 正在思考...${progress ? `（${progress.completed}/${progress.total}）` : ''}`
            : `开始分析 ${imageFiles.length > 0 ? imageFiles.length + ' 张图片' : ''}`}
        </button>
      </div>

      {isLoading && <div className="mt-8"><LoadingSpinner text="AI 正在观察您的图片..." /></div>}
      {isLoading && progress && (
        <div className="mt-3 text-center text-slate-600 text-sm">
          正在解析：{progress.currentFileName || '...'}（{progress.completed}/{progress.total}）
        </div>
      )}

      {analysisResults && (
        <div className="mt-10 p-6 md:p-8 bg-white/80 rounded-3xl border border-slate-200 shadow-sm backdrop-blur-sm">
          <h3 className="text-2xl font-bold text-slate-900 mb-6 flex items-center gap-2">
             📊 分析结果
          </h3>
          <FormattedMarkdownResultDisplay results={analysisResults} />
          <div className="mt-8 flex flex-wrap gap-4 justify-end items-center">
            <button
                onClick={handleSaveToKB}
                disabled={isSavingToKB}
                className={`font-bold py-3 px-6 rounded-full transition-colors duration-300 flex items-center gap-2 shadow-sm ${kbSaveSuccess ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white disabled:bg-slate-300 disabled:text-slate-600'}`}
            >
                <BookOpenIcon className="w-5 h-5"/>
                {isSavingToKB ? '保存中...' : (kbSaveSuccess ? '已存入知识库!' : '一键拆解到知识库')}
            </button>
            <button
              onClick={handleConfirm}
              className="bg-emerald-600 text-white font-bold py-3 px-8 rounded-full hover:bg-emerald-500 transition-all shadow-sm transform hover:scale-[1.02]"
            >
              下一步：去生成 &rarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
