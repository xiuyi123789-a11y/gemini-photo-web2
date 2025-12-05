
import React, { useState, useEffect, useMemo } from 'react';
import { FileUpload } from './FileUpload';
import { ImageFile, KnowledgeBaseEntry, KnowledgeBaseCategory, KnowledgeBaseAnalysis } from '../types';
import { analyzeAndCategorizeImageForKB } from '../services/replicateService';
import { 
    getKnowledgeBase, 
    addMultipleKnowledgeBaseEntries, 
    resizeImage, 
    KB_UPDATE_EVENT,
    softDeleteKnowledgeBaseEntries,
    restoreKnowledgeBaseEntries,
    permanentlyDeleteKnowledgeBaseEntries,
    cleanUpTrash
} from '../services/knowledgeBaseService';
import { LoadingSpinner } from './LoadingSpinner';
import { TrashIcon, ChevronDownIcon, FireIcon, CheckIcon, RefreshIcon, SearchIcon, XIcon } from './IconComponents';
import { useApiKey } from '../src/contexts/ApiKeyContext';

export const KnowledgeBaseView: React.FC = () => {
    const [entries, setEntries] = useState<KnowledgeBaseEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<string>('');
    const [analysisProgress, setAnalysisProgress] = useState<{current: number, total: number} | null>(null);
    const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});
    const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
    
    // New State for Deletion/Trash features
    const [viewMode, setViewMode] = useState<'active' | 'trash'>('active');
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const { apiKey } = useApiKey();

    const loadEntries = async () => {
        const data = await getKnowledgeBase();
        setEntries(data);
    };

    useEffect(() => {
        // Clean up old trash on mount
        cleanUpTrash().then(() => {
            loadEntries();
        });
        
        // Initialize categories state
        const initialOpenState = Object.values(KnowledgeBaseCategory).reduce((acc, cat) => {
            acc[cat] = true; 
            return acc;
        }, {} as Record<string, boolean>);
        setOpenCategories(initialOpenState);

        // Listen for updates from other components (e.g. SmartRetouchView saving)
        window.addEventListener(KB_UPDATE_EVENT, loadEntries);
        return () => {
            window.removeEventListener(KB_UPDATE_EVENT, loadEntries);
        }
    }, []);

    // Refresh list helper
    const refreshList = () => {
        loadEntries();
        setSelectedIds(new Set());
        setIsSelectionMode(false);
    };

    const toggleCategory = (category: KnowledgeBaseCategory) => {
        setOpenCategories(prev => ({ ...prev, [category]: !prev[category] }));
    };

    // Handlers for Selection
    const toggleSelection = (id: string) => {
        const newSelected = new Set(selectedIds);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedIds(newSelected);
        
        // Auto-enable selection mode if not active
        if (!isSelectionMode && newSelected.size > 0) {
            setIsSelectionMode(true);
        }
    };

    const handleSelectAll = () => {
        // Get all currently visible IDs
        const allVisibleIds = Object.values(filteredAndGroupedEntries).flat().map(e => e.id);
        
        if (selectedIds.size === allVisibleIds.length && allVisibleIds.length > 0) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(allVisibleIds));
        }
    };

    // Handlers for Actions
    const handleBatchDelete = async () => {
        if (selectedIds.size === 0) return;
        if (confirm(`确定要删除选中的 ${selectedIds.size} 个项目吗？`)) {
            await softDeleteKnowledgeBaseEntries(Array.from(selectedIds));
            refreshList();
        }
    };

    const handleBatchRestore = async () => {
        if (selectedIds.size === 0) return;
        await restoreKnowledgeBaseEntries(Array.from(selectedIds));
        refreshList();
    };

    const handleBatchPermanentDelete = async () => {
        if (selectedIds.size === 0) return;
        if (confirm(`⚠️ 警告：确定要永久删除选中的 ${selectedIds.size} 个项目吗？此操作无法撤销！`)) {
            await permanentlyDeleteKnowledgeBaseEntries(Array.from(selectedIds));
            refreshList();
        }
    };

    const handleFileAnalyze = async (files: ImageFile[]) => {
        if (files.length === 0) return;

        if (!apiKey) {
            setError("请先设置您的 API Key。");
            return;
        }
        
        setIsLoading(true);
        setError(null);
        setAnalysisProgress({ current: 0, total: files.length });

        let processedCount = 0;

        for (const imageFile of files) {
            try {
                const thumbnail = await resizeImage(imageFile.file);
                const analysisResult: KnowledgeBaseAnalysis = await analyzeAndCategorizeImageForKB(imageFile.file, apiKey);
                
                const newEntries: Omit<KnowledgeBaseEntry, 'id' | 'usageCount'>[] = [];
                
                // --- Create FRAGMENT entries from analysisResult.fragments ---
                for (const category in analysisResult.fragments) {
                    const promptFragment = analysisResult.fragments[category as KnowledgeBaseCategory];
                    if (promptFragment && typeof promptFragment === 'string') {
                        newEntries.push({
                            category: category as KnowledgeBaseCategory,
                            promptFragment,
                            sourceImagePreview: thumbnail,
                        });
                    }
                }

                // --- Create FULL PROMPT entry from analysisResult.holistic_description ---
                const consistentPromptText = `场景: ${analysisResult.fragments[KnowledgeBaseCategory.SCENE] || ''}. 风格: ${analysisResult.fragments[KnowledgeBaseCategory.STYLE] || ''}. 光照: ${analysisResult.fragments[KnowledgeBaseCategory.LIGHTING] || ''}.`;
                const variablePromptText = analysisResult.holistic_description;
                
                newEntries.push({
                    category: KnowledgeBaseCategory.FULL_PROMPT,
                    promptFragment: `完整复刻: ${variablePromptText.substring(0, 50)}...`,
                    sourceImagePreview: thumbnail,
                    fullPrompt: {
                        consistentPrompt: consistentPromptText,
                        variablePrompt: variablePromptText,
                    }
                });

                addMultipleKnowledgeBaseEntries(newEntries);
                processedCount++;
                setAnalysisProgress({ current: processedCount, total: files.length });

            } catch (e: any) {
                console.error(`Failed to process file ${imageFile.file.name}:`, e);
                setError(`处理文件 ${imageFile.file.name} 失败: ${e.message}`);
            }
        }
        
        setIsLoading(false);
        setAnalysisProgress(null);
    };
    
    const handleDelete = async (id: string) => {
        // Use soft delete now
        await softDeleteKnowledgeBaseEntries([id]);
        refreshList(); // Refresh to update view (item will disappear from 'active' view)
    };

    const filteredAndGroupedEntries = useMemo(() => {
        let filtered = entries.filter(entry => 
            entry.promptFragment.toLowerCase().includes(filter.toLowerCase()) ||
            entry.category.toLowerCase().includes(filter.toLowerCase())
        );

        // Filter by View Mode (Active vs Trash)
        filtered = filtered.filter(entry => {
            const isTrashItem = !!entry.deletedAt;
            return viewMode === 'active' ? !isTrashItem : isTrashItem;
        });

        return filtered.reduce((acc, entry) => {
            if (!acc[entry.category]) {
                acc[entry.category] = [];
            }
            acc[entry.category].push(entry);
            return acc;
        }, {} as Record<KnowledgeBaseCategory, KnowledgeBaseEntry[]>);
    }, [entries, filter, viewMode]);

    const expandedEntry = useMemo(() => {
        if (!expandedEntryId) return null;
        return entries.find(e => e.id === expandedEntryId);
    }, [entries, expandedEntryId]);

    return (
        <div>
            {expandedEntry && (
                <div 
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
                    onClick={() => setExpandedEntryId(null)}
                >
                    <div 
                        className="bg-slate-800 border border-white/10 rounded-3xl shadow-2xl max-w-3xl w-full h-[80vh] flex flex-col overflow-hidden relative"
                        onClick={e => e.stopPropagation()}
                    >
                        <button 
                            onClick={() => setExpandedEntryId(null)}
                            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-red-500/80 text-white rounded-full transition-colors z-10"
                        >
                            <XIcon className="w-6 h-6" />
                        </button>
                        
                        <div className="flex flex-col md:flex-row h-full">
                            <div className="w-full md:w-1/3 h-48 md:h-full bg-black flex items-center justify-center flex-shrink-0">
                                <img src={expandedEntry.sourceImagePreview} alt="Source" className="w-full h-full object-contain" />
                            </div>
                            <div className="flex-grow p-6 md:p-8 overflow-y-auto custom-scrollbar bg-slate-800/50">
                                <div className="mb-4">
                                    <span className="inline-block px-3 py-1 rounded-full text-xs font-bold bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30 mb-2">
                                        {expandedEntry.category}
                                    </span>
                                    {expandedEntry.category === KnowledgeBaseCategory.FULL_PROMPT && expandedEntry.fullPrompt && (
                                        <div className="space-y-6">
                                            <div>
                                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-2">一致性描述 (Consistent)</h4>
                                                <p className="text-slate-200 leading-relaxed text-lg border-l-4 border-fuchsia-500 pl-4 bg-fuchsia-500/5 p-2 rounded-r-lg">
                                                    {expandedEntry.fullPrompt.consistentPrompt}
                                                </p>
                                            </div>
                                            <div>
                                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-2">变量描述 (Variable)</h4>
                                                <p className="text-slate-200 leading-relaxed text-lg border-l-4 border-blue-500 pl-4 bg-blue-500/5 p-2 rounded-r-lg">
                                                    {expandedEntry.fullPrompt.variablePrompt}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                    {(!expandedEntry.fullPrompt) && (
                                        <p className="text-slate-100 leading-relaxed text-lg whitespace-pre-wrap font-medium">
                                            {expandedEntry.promptFragment}
                                        </p>
                                    )}
                                </div>
                                
                                <div className="pt-6 border-t border-white/10 flex justify-between items-center text-slate-400 text-sm">
                                    <div className="flex items-center gap-2">
                                        <FireIcon className="w-4 h-4 text-amber-500" />
                                        <span>使用次数: {expandedEntry.usageCount || 0}</span>
                                    </div>
                                    {viewMode === 'active' && (
                                        <button 
                                            onClick={() => {
                                                handleDelete(expandedEntry.id);
                                                setExpandedEntryId(null);
                                            }}
                                            className="flex items-center gap-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 px-3 py-1.5 rounded-lg transition-colors"
                                        >
                                            <TrashIcon className="w-4 h-4" />
                                            删除此条目
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="text-center mb-8 flex flex-col items-center">
                <div className="flex items-center gap-4 mb-2">
                     <h2 className="text-3xl font-bold text-white">
                        {viewMode === 'active' ? '✨ 灵感知识库' : '🗑️ 回收站'}
                    </h2>
                    <button 
                        onClick={() => {
                            setViewMode(viewMode === 'active' ? 'trash' : 'active');
                            setSelectedIds(new Set());
                            setIsSelectionMode(false);
                        }}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-full transition-all border text-sm ${
                            viewMode === 'trash' 
                                ? 'bg-fuchsia-600 text-white border-fuchsia-500 shadow-lg shadow-fuchsia-500/20' 
                                : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700 hover:text-white'
                        }`}
                    >
                        {viewMode === 'active' ? (
                            <>
                                <TrashIcon className="w-4 h-4" />
                                <span>回收站</span>
                            </>
                        ) : (
                            <>
                                <SearchIcon className="w-4 h-4" />
                                <span>知识库</span>
                            </>
                        )}
                    </button>
                </div>
                <p className="text-slate-400">
                    {viewMode === 'active' 
                        ? '上传您喜欢的图片，AI会自动解析其美学基因，转化为您的专属创作素材。' 
                        : '这里保存了最近 30 天删除的内容，您可以随时恢复它们。'}
                </p>
            </div>

            {viewMode === 'active' && (
                <div className="mb-8 p-8 bg-slate-800/50 rounded-3xl border border-white/10 shadow-xl backdrop-blur-sm">
                    <h3 className="text-lg font-bold text-white mb-4 ml-1">📥 添加新灵感 (AI 自动拆解)</h3>
                    {isLoading ? (
                        <LoadingSpinner text={`正在提取美学基因... (${analysisProgress?.current} / ${analysisProgress?.total})`} />
                    ) : (
                        <FileUpload onFilesSelected={handleFileAnalyze} multiple={true} />
                    )}
                    {error && <p className="text-red-400 mt-4 text-center">{error}</p>}
                </div>
            )}

            <div className="bg-slate-900/30 rounded-3xl p-8 border border-white/5 relative">
                <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
                    <h3 className="text-xl font-bold text-white">
                         {viewMode === 'active' ? '📚 浏览素材' : '🗑️ 已删除内容'}
                    </h3>
                    <input
                        type="text"
                        placeholder="🔍 搜索提示词或分类..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="w-full md:w-1/3 p-3 bg-slate-800 border border-slate-600 rounded-full focus:ring-2 focus:ring-fuchsia-500 focus:outline-none text-sm"
                    />
                </div>

                {Object.keys(filteredAndGroupedEntries).length === 0 && !isLoading ? (
                    <div className="text-center py-16 text-slate-500 flex flex-col items-center">
                        <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mb-4 text-4xl">
                            {viewMode === 'active' ? '🤷‍♂️' : '🗑️'}
                        </div>
                        <p className="text-lg">
                            {viewMode === 'active' ? '知识库空空如也，或未找到匹配项。' : '回收站是空的。'}
                        </p>
                        {viewMode === 'active' && <p className="text-sm mt-2">试着上传一些图片来填充它吧！</p>}
                    </div>
                ) : (
                    <div className="space-y-8 pb-20"> {/* Padding bottom for action bar */}
                        {(Object.values(KnowledgeBaseCategory)).filter(category => filteredAndGroupedEntries[category]?.length > 0).map(category => (
                            <div key={category} className="bg-slate-800/30 rounded-2xl p-4 border border-white/5">
                                <button onClick={() => toggleCategory(category)} className="w-full flex justify-between items-center text-left mb-2 p-2 rounded-lg hover:bg-white/5 transition-colors">
                                    <h4 className="text-xl font-bold text-fuchsia-300 flex items-center gap-2">
                                        {category}
                                        {category === KnowledgeBaseCategory.RETOUCH_LEARNING && <span className="bg-blue-500/20 text-blue-300 text-xs px-2 py-0.5 rounded-full">AI Memory</span>}
                                    </h4>
                                    <div className="flex items-center gap-2 text-slate-400 text-sm">
                                        <span>{filteredAndGroupedEntries[category].length} 个条目</span>
                                        <ChevronDownIcon className={`w-5 h-5 transition-transform duration-300 ${openCategories[category] ? 'rotate-180' : ''}`} />
                                    </div>
                                </button>
                                <div className={`transition-all duration-500 ease-in-out grid-flow-row overflow-hidden ${openCategories[category] ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}`}>
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                                        {filteredAndGroupedEntries[category].map(entry => (
                                            <div 
                                                key={entry.id} 
                                                className={`group bg-slate-700/50 rounded-xl p-3 flex gap-3 relative border transition-all hover:bg-slate-700 cursor-pointer ${
                                                    selectedIds.has(entry.id) ? 'border-fuchsia-500 bg-fuchsia-500/10' : 'border-transparent hover:border-fuchsia-500/30'
                                                }`}
                                                onClick={() => {
                                                    if (isSelectionMode) {
                                                        toggleSelection(entry.id);
                                                    } else {
                                                        setExpandedEntryId(entry.id);
                                                    }
                                                }}
                                            >
                                                {/* Checkbox (Visible on hover or selection mode) */}
                                                <div 
                                                    className={`absolute top-2 left-2 z-20 transition-all duration-200 ${
                                                        isSelectionMode || selectedIds.has(entry.id) ? 'opacity-100 scale-100' : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
                                                    }`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleSelection(entry.id);
                                                    }}
                                                >
                                                    <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors shadow-lg ${
                                                        selectedIds.has(entry.id) 
                                                            ? 'bg-fuchsia-600 border-fuchsia-600 text-white' 
                                                            : 'bg-slate-900/80 border-slate-600 hover:border-fuchsia-500 text-transparent'
                                                    }`}>
                                                        <CheckIcon className="w-4 h-4" />
                                                    </div>
                                                </div>

                                                {entry.category === KnowledgeBaseCategory.FULL_PROMPT && (
                                                    <span className="absolute top-2 right-2 text-[10px] bg-fuchsia-500 text-white font-bold px-2 py-0.5 rounded-full shadow-sm z-10">复刻</span>
                                                )}
                                                <div className="w-20 h-20 flex-shrink-0 rounded-lg overflow-hidden bg-slate-800">
                                                    <img src={entry.sourceImagePreview} alt="Source" className="w-full h-full object-cover" />
                                                </div>
                                                <div className="flex-grow flex flex-col justify-between min-w-0">
                                                    <p className="text-slate-200 text-sm mb-1 line-clamp-3 font-medium pl-6">{entry.promptFragment}</p> {/* Added padding-left for checkbox space */}
                                                    <div className="flex justify-between items-center">
                                                        <div className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded" title="应用次数">
                                                            <FireIcon className="w-3 h-3" />
                                                            <span>{entry.usageCount || 0}</span>
                                                        </div>
                                                        {viewMode === 'active' && (
                                                            <button 
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDelete(entry.id);
                                                                }} 
                                                                className="self-end p-1.5 rounded-full text-slate-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                                                            >
                                                                <TrashIcon className="w-4 h-4" />
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                 {/* Batch Action Bar */}
                 {selectedIds.size > 0 && (
                     <div className="fixed bottom-8 left-1/2 transform -translate-x-1/2 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-6 animate-fade-in z-50">
                         <div className="flex items-center gap-3 border-r border-slate-700 pr-6">
                             <div className="w-5 h-5 bg-fuchsia-500 rounded text-white flex items-center justify-center text-xs font-bold">
                                 {selectedIds.size}
                             </div>
                             <span className="text-slate-300 text-sm font-medium">已选择</span>
                             
                             <button 
                                 onClick={handleSelectAll}
                                 className="text-xs text-slate-500 hover:text-fuchsia-400 transition-colors ml-2"
                             >
                                 {selectedIds.size === Object.values(filteredAndGroupedEntries).flat().length ? '取消全选' : '全选'}
                             </button>
                         </div>
 
                         <div className="flex items-center gap-3">
                             {viewMode === 'active' ? (
                                 <button 
                                     onClick={handleBatchDelete}
                                     className="flex items-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-bold transition-colors shadow-lg shadow-red-500/20"
                                 >
                                     <TrashIcon className="w-4 h-4" />
                                     删除
                                 </button>
                             ) : (
                                 <>
                                     <button 
                                         onClick={handleBatchRestore}
                                         className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-sm font-bold transition-colors shadow-lg shadow-emerald-500/20"
                                     >
                                         <RefreshIcon className="w-4 h-4" />
                                         恢复
                                     </button>
                                     <button 
                                         onClick={handleBatchPermanentDelete}
                                         className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-xl text-sm font-bold transition-colors"
                                     >
                                         <TrashIcon className="w-4 h-4" />
                                         彻底删除
                                     </button>
                                 </>
                             )}
                         </div>
                     </div>
                 )}
            </div>
        </div>
    );
};
