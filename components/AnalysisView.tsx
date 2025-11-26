
import React, { useState } from 'react';
import { analyzeImages } from '../services/geminiService';
import { addAnalysisResultToKB } from '../services/knowledgeBaseService';
import { AnalysisResult, ImageFile } from '../types';
import { FileUpload } from './FileUpload';
import { LoadingSpinner } from './LoadingSpinner';
import { BookOpenIcon } from './IconComponents';

interface AnalysisViewProps {
  onAnalysisComplete: (result: AnalysisResult) => void;
}

const formatResultToMarkdown = (result: AnalysisResult): string => {
    let md = '### 一致性元素\n\n';
    const { consistent_elements, inconsistent_elements } = result;

    md += `**主要主体**\n`;
    md += `- **物品**: ${consistent_elements.primary_subject.item}\n`;
    md += `- **关键特征**: ${consistent_elements.primary_subject.key_features.join(', ')}\n`;
    md += `- **材质**: ${consistent_elements.primary_subject.materials.join(', ')}\n`;
    md += `- **品牌**: ${consistent_elements.primary_subject.brand}\n`;
    md += `- **情感氛围**: ${consistent_elements.primary_subject.emotional_tone}\n\n`;

    md += `**场景环境**\n`;
    md += `- **地点**: ${consistent_elements.scene_environment.general_location}\n`;
    md += `- **共享元素**: ${consistent_elements.scene_environment.shared_elements.join(', ')}\n\n`;

    md += `**图像质量与构图**\n`;
    md += `- **风格**: ${consistent_elements.image_quality_and_composition.style}\n`;
    md += `- **光照**: ${consistent_elements.image_quality_and_composition.lighting}\n`;
    md += `- **质量**: ${consistent_elements.image_quality_and_composition.quality}\n`;
    md += `- **镜头类型**: ${consistent_elements.image_quality_and_composition.lens_type}\n\n`;

    md += '---\n\n### 非一致性元素\n\n';
    inconsistent_elements.forEach(item => {
        md += `**图片 ${item.image_index}**\n`;
        md += `- **景别**: ${item.framing}\n`;
        md += `- **姿势**: ${item.subject_pose}\n`;
        md += `- **人物描述**: ${item.person_description}\n`;
        md += `- **独特细节**: ${item.unique_details}\n`;
        md += `- **宽高比**: ${item.aspect_ratio}\n`;
        md += `- **相机设置**: ${item.camera_settings}\n\n`;
    });

    return md;
};

const FormattedMarkdownResultDisplay: React.FC<{ result: AnalysisResult }> = ({ result }) => {
    const markdownString = formatResultToMarkdown(result);
    return (
        <pre className="bg-slate-900/80 p-6 rounded-2xl text-sm text-slate-300 overflow-x-auto font-mono whitespace-pre-wrap border border-white/5 shadow-inner">
            <code>{markdownString}</code>
        </pre>
    );
};


import { useApiKey } from '../src/contexts/ApiKeyContext';

export const AnalysisView: React.FC<AnalysisViewProps> = ({ onAnalysisComplete }) => {
  const [imageFiles, setImageFiles] = useState<ImageFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingToKB, setIsSavingToKB] = useState(false);
  const [kbSaveSuccess, setKbSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const { apiKey } = useApiKey();

  const handleFileSelect = (files: ImageFile[]) => {
    setImageFiles(files);
    setAnalysisResult(null);
    setError(null);
    setKbSaveSuccess(false);
  };

  const handleAnalyze = async () => {
    if (imageFiles.length === 0) {
      setError('请至少上传一张图片。');
      return;
    }
    if (!apiKey) {
      setError('请先设置您的 API Key。');
      return;
    }
    setIsLoading(true);
    setError(null);
    setAnalysisResult(null);
    setKbSaveSuccess(false);

    try {
      const result = await analyzeImages(imageFiles.map(f => f.file), apiKey);
      setAnalysisResult(result);
    } catch (e: any) {
      setError(e.message || '发生未知错误。');
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleConfirm = () => {
    if (analysisResult) {
        onAnalysisComplete(analysisResult);
    }
  };

  const handleSaveToKB = async () => {
    if (!analysisResult) return;
    setIsSavingToKB(true);
    setKbSaveSuccess(false);
    setError(null);
    try {
      await addAnalysisResultToKB(analysisResult, imageFiles);
      setKbSaveSuccess(true);
      setTimeout(() => setKbSaveSuccess(false), 3000); // Reset after 3s
    } catch(e: any) {
      setError(e.message || "存入知识库失败。");
    } finally {
      setIsSavingToKB(false);
    }
  };

  return (
    <div>
      <div className="text-center mb-8">
        <h2 className="text-3xl font-extrabold text-white mb-2 bg-clip-text text-transparent bg-gradient-to-r from-blue-300 to-fuchsia-300">智能解析</h2>
        <p className="text-slate-400">上传同一主题的多张图片，提取一致性和独特的元素，为您的创意打下基础。</p>
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

      {isLoading && <div className="mt-8"><LoadingSpinner text="Gemini 正在深度解析视觉元素..." /></div>}

      {analysisResult && (
        <div className="mt-10 p-6 md:p-8 bg-slate-800/50 rounded-3xl border border-white/10 shadow-2xl backdrop-blur-sm">
          <h3 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
             📊 分析结果
          </h3>
          <FormattedMarkdownResultDisplay result={analysisResult} />
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
