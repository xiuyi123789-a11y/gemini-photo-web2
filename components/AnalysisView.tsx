
import React, { useState } from 'react';
import { analyzeImages } from '../services/replicateService';
import { addAnalysisResultToKB } from '../services/knowledgeBaseService';
import { AnalysisResult, ImageFile } from '../types';
import { FileUpload } from './FileUpload';
import { LoadingSpinner } from './LoadingSpinner';
import { BookOpenIcon } from './IconComponents';

interface AnalysisViewProps {
  onAnalysisComplete: (result: AnalysisResult[]) => void;
}

const FormattedMarkdownResultDisplay: React.FC<{ results: AnalysisResult[] }> = ({ results }) => {
    return (
        <div className="space-y-6">
            {results.map((res, idx) => (
                <div key={idx} className="bg-slate-900/80 p-6 rounded-2xl text-sm text-slate-300 border border-white/5 shadow-inner">
                    <h4 className="text-lg font-bold text-fuchsia-400 mb-3 border-b border-white/10 pb-2 flex justify-between">
                        <span>📄 {res.fileName}</span>
                        <span className="text-slate-500 font-normal text-xs">{new Date(res.timestamp || '').toLocaleString()}</span>
                    </h4>
                    <div className="whitespace-pre-wrap font-sans leading-relaxed">{res.analysis}</div>
                    {res.error && <p className="text-red-400 mt-2 text-xs">⚠️ 此文件解析遇到错误</p>}
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

  const handleFileSelect = (files: ImageFile[]) => {
    setImageFiles(files);
    setAnalysisResults(null);
    setError(null);
    setKbSaveSuccess(false);
  };

  const handleAnalyze = async () => {
    if (imageFiles.length === 0) {
      setError('请至少上传一张图片。');
      return;
    }
    setIsLoading(true);
    setError(null);
    setAnalysisResults(null);
    setKbSaveSuccess(false);

    try {
      const results = await analyzeImages(imageFiles.map(f => f.file));
      setAnalysisResults(results);
    } catch (e: any) {
      setError(e.message || '发生未知错误。');
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleConfirm = () => {
    if (analysisResults) {
        onAnalysisComplete(analysisResults);
    }
  };

  const handleSaveToKB = async () => {
        if (!analysisResults || analysisResults.length === 0) return;
        
        setIsSavingToKB(true);
        try {
            // Save each result individually
            for (const result of analysisResults) {
                await addAnalysisResultToKB(result, imageFiles);
            }
            setKbSaveSuccess(true);
            setTimeout(() => setKbSaveSuccess(false), 3000);
        } catch (e) {
            console.error("Failed to save to KB", e);
            setError("保存到知识库失败，请重试。");
        } finally {
            setIsSavingToKB(false);
        }
    };

    return (
        <div>
            <div className="text-center mb-8">
                <h2 className="text-3xl font-extrabold text-white mb-2 bg-clip-text text-transparent bg-gradient-to-r from-blue-300 to-fuchsia-300">智能解析 (GPT-4o Vision)</h2>
                <p className="text-slate-400">上传图片，利用 OpenAI GPT-4o-mini 模型进行深度视觉分析。</p>
            </div>

            {imageFiles.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-bold text-slate-200 mb-3 ml-1">已上传预览</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {imageFiles.map((imageFile, index) => (
              <img key={index} src={imageFile.preview} alt={`preview ${index}`} className="w-full h-full object-cover rounded-2xl border-2 border-white/10 aspect-square shadow-md" />
            ))}
          </div>
        </div>
      )}

      <FileUpload onFilesSelected={handleFileSelect} multiple={true} />
      
      {error && <p className="text-red-400 mt-4 text-center bg-red-500/10 py-2 rounded-lg">{error}</p>}
      
      <div className="mt-8 flex justify-center">
        <button
          onClick={handleAnalyze}
          disabled={isLoading || imageFiles.length === 0}
          className="bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white font-bold py-3 px-10 rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-105 shadow-lg shadow-fuchsia-500/30"
        >
          {isLoading ? 'AI 正在思考...' : `开始分析 ${imageFiles.length > 0 ? imageFiles.length + ' 张图片' : ''}`}
        </button>
      </div>

      {isLoading && <div className="mt-8"><LoadingSpinner text="AI 正在观察您的图片..." /></div>}

      {analysisResults && (
        <div className="mt-10 p-6 md:p-8 bg-slate-800/50 rounded-3xl border border-white/10 shadow-2xl backdrop-blur-sm">
          <h3 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
             📊 分析结果
          </h3>
          <FormattedMarkdownResultDisplay results={analysisResults} />
          <div className="mt-8 flex flex-wrap gap-4 justify-end items-center">
            <button
                onClick={handleSaveToKB}
                disabled={isSavingToKB}
                className={`font-bold py-3 px-6 rounded-full transition-colors duration-300 flex items-center gap-2 shadow-md ${kbSaveSuccess ? 'bg-green-500 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white disabled:bg-slate-600'}`}
            >
                <BookOpenIcon className="w-5 h-5"/>
                {isSavingToKB ? '保存中...' : (kbSaveSuccess ? '已存入知识库!' : '一键拆解到知识库')}
            </button>
            <button
              onClick={handleConfirm}
              className="bg-emerald-600 text-white font-bold py-3 px-8 rounded-full hover:bg-emerald-500 transition-all shadow-lg hover:shadow-emerald-500/30 transform hover:scale-105"
            >
              下一步：去生成 &rarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
