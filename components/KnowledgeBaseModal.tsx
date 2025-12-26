
import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { 
    getKnowledgeBase, 
    softDeleteKnowledgeBaseEntries, 
    restoreKnowledgeBaseEntries, 
    permanentlyDeleteKnowledgeBaseEntries,
    cleanUpTrash 
} from '../services/knowledgeBaseService';
import { KnowledgeBaseEntry, KnowledgeBaseCategory } from '../types';
import { XIcon, FireIcon, SearchIcon, TrashIcon, CheckIcon, RefreshIcon } from './IconComponents';

interface KnowledgeBaseModalProps {
    onClose: () => void;
    onSelectEntry: (entry: KnowledgeBaseEntry) => void;
    currentContextPrompt?: string; // The "Original Image Understanding" or context prompt
}

export const KnowledgeBaseModal: React.FC<KnowledgeBaseModalProps> = ({ onClose, onSelectEntry, currentContextPrompt = '' }) => {
    const [entries, setEntries] = useState<KnowledgeBaseEntry[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<string>('全部');
    
    // New State for Deletion/Trash features
    const [viewMode, setViewMode] = useState<'active' | 'trash'>('active');
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // Fetch Data
    const fetchKnowledgeBase = async () => {
        try {
            const data = await getKnowledgeBase();
            setEntries(data);
        } catch (error) {
            console.error("Failed to fetch knowledge base:", error);
            setEntries([]);
        }
    };

    useEffect(() => {
        // Clean up old trash on mount
        cleanUpTrash().then(() => {
            fetchKnowledgeBase();
        });
    }, []);

    // Refresh list helper
    const refreshList = () => {
        fetchKnowledgeBase();
        setSelectedIds(new Set());
        setIsSelectionMode(false);
    };

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleEsc);
        return () => window.removeEventListener('keydown', handleEsc);
    }, [onClose]);

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
        // Auto-disable if empty (Optional, but maybe good UX to keep it on?)
        // Let's keep it on until user explicitly cancels or performs action
    };

    const handleSelectAll = () => {
        if (selectedIds.size === processedEntries.length) {
            setSelectedIds(new Set());
        } else {
            const allIds = new Set(processedEntries.map(e => e.id));
            setSelectedIds(allIds);
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

    // Helper: Tokenize text for comparison
    const tokenize = (text: string) => {
        return new Set(text.toLowerCase().replace(/[^\w\s\u4e00-\u9fa5]/g, '').split(/\s+/).filter(t => t.length > 0));
    };

    // Helper: Calculate Jaccard Similarity
    const calculateSimilarity = (text1: string, text2: string) => {
        const set1 = tokenize(text1);
        const set2 = tokenize(text2);
        if (set1.size === 0 || set2.size === 0) return 0;
        
        let intersection = 0;
        set1.forEach(token => {
            if (set2.has(token)) intersection++;
        });
        
        const union = set1.size + set2.size - intersection;
        return union === 0 ? 0 : intersection / union;
    };

    const processedEntries = useMemo(() => {
        const maxUsage = Math.max(...entries.map(e => e.usageCount || 0), 1);

        // 1. Calculate Scores
        const scoredEntries = entries.map(entry => {
            // Prepare entry text for comparison (Fragment + Full Prompt parts)
            let entryText = entry.promptFragment;
            if (entry.fullPrompt) {
                entryText += ` ${entry.fullPrompt.consistentPrompt} ${entry.fullPrompt.variablePrompt}`;
            }

            // Usage Score (Normalized 0-1)
            const usageScore = (entry.usageCount || 0) / maxUsage;

            // Relevance Score (0-1)
            // If currentContextPrompt is empty, relevance is 0.
            const relevanceScore = currentContextPrompt ? calculateSimilarity(currentContextPrompt, entryText) : 0;

            // Weighted Final Score
            // 40% Usage, 60% Relevance
            const finalScore = (usageScore * 0.4) + (relevanceScore * 0.6);

            return { ...entry, finalScore };
        });

        // 2. Filter
        let filtered = scoredEntries.filter(entry => {
            const matchesCategory = selectedCategory === '全部' || entry.category === selectedCategory;
            const matchesSearch = searchQuery.trim() === '' || 
                entry.promptFragment.toLowerCase().includes(searchQuery.toLowerCase()) || 
                entry.category.toLowerCase().includes(searchQuery.toLowerCase());
            
            // Check View Mode (Active vs Trash)
            const isTrashItem = !!entry.deletedAt;
            const matchesViewMode = viewMode === 'active' ? !isTrashItem : isTrashItem;

            return matchesCategory && matchesSearch && matchesViewMode;
        });

        // 3. Sort
        return filtered.sort((a, b) => b.finalScore - a.finalScore);

    }, [entries, searchQuery, selectedCategory, currentContextPrompt, viewMode]);

    const categories = ['全部', ...Object.values(KnowledgeBaseCategory)];

    const modal = (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={onClose}>
            <div
                className="ql-edit bg-white/90 border border-slate-200 rounded-3xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden animate-fade-in"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <header className="p-6 border-b border-slate-200 flex justify-between items-center flex-shrink-0 bg-white/60">
                    <div>
                        <h3 className="text-2xl font-bold text-slate-900 mb-1">
                            {viewMode === 'active' ? '✨ 灵感知识库' : '🗑️ 回收站'}
                        </h3>
                        <p className="text-slate-600 text-sm">
                            {viewMode === 'active' ? '基于 AI 理解为您推荐最匹配的创意' : '这里保存了最近 30 天删除的内容'}
                        </p>
                    </div>
                    <div className="flex items-center gap-4">
                        <button 
                            onClick={() => {
                                setViewMode(viewMode === 'active' ? 'trash' : 'active');
                                setSelectedIds(new Set());
                                setIsSelectionMode(false);
                            }}
                            className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all border ${
                                viewMode === 'trash' 
                                    ? 'bg-fuchsia-600 text-white border-fuchsia-600 shadow-lg shadow-fuchsia-500/20'
                                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                            }`}
                        >
                            {viewMode === 'active' ? (
                                <>
                                    <TrashIcon className="w-5 h-5" />
                                    <span className="text-sm font-medium">回收站</span>
                                </>
                            ) : (
                                <>
                                    <SearchIcon className="w-5 h-5" />
                                    <span className="text-sm font-medium">知识库</span>
                                </>
                            )}
                        </button>

                        <button onClick={onClose} className="text-slate-500 hover:text-slate-900 p-2 hover:bg-slate-100 rounded-full transition-colors">
                            <XIcon className="w-6 h-6" />
                        </button>
                    </div>
                </header>
                
                {/* Search & Filter */}
                <div className="p-6 flex-shrink-0 bg-white/40 space-y-4 border-b border-slate-200">
                     <div className="relative">
                        <SearchIcon className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-500" />
                        <input
                            type="text"
                            placeholder="🔍 搜索提示词、风格或分类..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent text-slate-900 placeholder-slate-400 transition-all"
                        />
                    </div>
                    
                    {/* Category Chips */}
                    <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
                        {categories.map(cat => (
                            <button
                                key={cat}
                                onClick={() => setSelectedCategory(cat)}
                                className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all border ${
                                    selectedCategory === cat
                                        ? 'bg-fuchsia-600 text-white border-fuchsia-600 shadow-lg shadow-fuchsia-500/20'
                                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                                }`}
                            >
                                {cat}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Content List */}
                <main className="overflow-y-auto p-6 bg-white/40">
                    {processedEntries.length > 0 ? (
                        <div className="grid grid-cols-1 gap-4">
                            {processedEntries.map(entry => (
                                <div 
                                    key={entry.id} 
                                    className={`group bg-white/70 hover:bg-slate-50 border rounded-2xl p-4 flex gap-5 items-center cursor-pointer transition-all duration-300 relative overflow-hidden ${
                                        selectedIds.has(entry.id) ? 'border-fuchsia-500 bg-fuchsia-500/5' : 'border-slate-200 hover:border-fuchsia-500/30'
                                    }`}
                                    onClick={() => {
                                        if (isSelectionMode) {
                                            toggleSelection(entry.id);
                                        } else {
                                            onSelectEntry(entry);
                                        }
                                    }}
                                >
                                    {/* Checkbox (Visible on hover or selection mode) */}
                                    <div 
                                        className={`absolute top-3 left-3 z-20 transition-all duration-200 ${
                                            isSelectionMode || selectedIds.has(entry.id) ? 'opacity-100 scale-100' : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
                                        }`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleSelection(entry.id);
                                        }}
                                    >
                                        <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors ${
                                            selectedIds.has(entry.id) 
                                                ? 'bg-fuchsia-600 border-fuchsia-600 text-white' 
                                                : 'bg-white border-slate-200 hover:border-fuchsia-500 text-transparent'
                                        }`}>
                                            <CheckIcon className="w-4 h-4" />
                                        </div>
                                    </div>

                                    {/* Hover Effect Gradient */}
                                    <div className="absolute inset-0 bg-gradient-to-r from-fuchsia-500/0 via-fuchsia-500/0 to-fuchsia-500/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                                    {/* Image */}
                                    <div className="relative flex-shrink-0">
                                        <img src={entry.sourceImagePreview} alt="Preview" className="w-20 h-20 object-cover rounded-xl bg-slate-100 shadow-sm group-hover:scale-105 transition-transform duration-500" />
                                        {entry.category === KnowledgeBaseCategory.FULL_PROMPT && (
                                            <div className="absolute -top-2 -left-2 bg-gradient-to-r from-fuchsia-600 to-purple-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg z-10">
                                                复刻
                                            </div>
                                        )}
                                    </div>

                                    {/* Content */}
                                    <div className="flex-grow min-w-0 pl-6">
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <h4 className="text-slate-900 font-medium text-base truncate group-hover:text-fuchsia-700 transition-colors">
                                                {entry.promptFragment.slice(0, 50)}{entry.promptFragment.length > 50 ? '...' : ''}
                                            </h4>
                                        </div>
                                        <p className="text-slate-600 text-sm line-clamp-2 leading-relaxed">
                                            {entry.fullPrompt ? entry.fullPrompt.consistentPrompt : entry.promptFragment}
                                        </p>
                                    </div>

                                    {/* Metadata / Badges (Right Side) */}
                                    <div className="flex flex-col items-end gap-2 flex-shrink-0 pl-4 border-l border-slate-200">
                                        {/* Category Badge */}
                                        <span className="px-2.5 py-1 rounded-lg bg-slate-50 text-slate-700 text-xs font-medium border border-slate-200">
                                            {entry.category}
                                        </span>

                                        {/* Usage Count */}
                                        <div className="flex items-center gap-1.5 text-amber-500 bg-amber-500/10 px-2.5 py-1 rounded-lg border border-amber-500/20" title="热度 (使用次数)">
                                            <FireIcon className="w-3.5 h-3.5" />
                                            <span className="text-xs font-bold">{entry.usageCount || 0}</span>
                                        </div>
                                        
                                        {/* Match Score (Debug/Optional - nice to show if relevant) */}
                                        {currentContextPrompt && (
                                            <div className="text-xs font-mono text-fuchsia-600/70">
                                                {Math.round(entry.finalScore * 100)}%
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-600">
                            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4 border border-slate-200">
                                <SearchIcon className="w-8 h-8 opacity-50" />
                            </div>
                            <p>没有找到匹配的灵感...</p>
                        </div>
                    )}
                </main>

                {/* Batch Action Bar */}
                {selectedIds.size > 0 && (
                    <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 bg-white border border-slate-200 rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-6 animate-fade-in z-50">
                        <div className="flex items-center gap-3 border-r border-slate-200 pr-6">
                            <div className="w-5 h-5 bg-fuchsia-500 rounded text-white flex items-center justify-center text-xs font-bold">
                                {selectedIds.size}
                            </div>
                            <span className="text-slate-700 text-sm font-medium">已选择</span>
                            
                            <button 
                                onClick={handleSelectAll}
                                className="text-xs text-slate-600 hover:text-fuchsia-700 transition-colors ml-2"
                            >
                                {selectedIds.size === processedEntries.length ? '取消全选' : '全选'}
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

    if (typeof document === 'undefined') return modal;
    return createPortal(modal, document.body);
};
