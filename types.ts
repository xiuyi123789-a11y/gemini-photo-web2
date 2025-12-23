
export interface ImageFile {
  file: File;
  preview: string;
}

export interface ReferenceImageFile {
  id: string;
  file: File;
  originalPreview: string;
  processedPreview: string | null;
  isProcessing: boolean;
}

export interface SynthesizedDefinition {
  subject_summary: string;
  core_subject_details: string;
  scene_atmosphere: string;
  visual_quality: string;
  // Legacy fields for backward compatibility
  subject_type?: string;
  human_features?: string | null;
}

export interface ConsistentElements {
  synthesized_definition: SynthesizedDefinition;
  // Legacy fields (optional for backward compatibility if needed, or remove if fully migrating)
  primary_subject?: any;
  scene_environment?: any;
  image_quality_and_composition?: any;
}

export interface InconsistentElement {
  image_index: number;
  subject_ref: string;
  action_and_pose: string;
  camera_angle: string;
  // Legacy fields
  content_type?: string;
  unique_features?: string;
  framing?: string;
  subject_pose?: string;
  person_description?: string;
  unique_details?: string;
  aspect_ratio?: string;
  camera_settings?: string;
}

export interface AnalysisResult {
  // Legacy structure (Optional for backward compatibility)
  consistent_elements?: ConsistentElements;
  inconsistent_elements?: InconsistentElement[];
  
  // New simplified structure
  fileName?: string;
  analysis?: string;
  timestamp?: string;
  error?: boolean;
}

export interface VariablePrompt {
  id: string;
  prompt: string;
  referenceImages?: Array<{
    id: string;
    file: File;
    preview: string;
  }>;
  imageAnalyses?: Record<string, KnowledgeBaseAnalysis>;
  isAnalyzing?: boolean;
}

export interface GeneratedImage {
    src: string | null;
    isLoading: boolean;
}

export type GeneratedImageState = Record<string, GeneratedImage>;

// --- KNOWLEDGE BASE TYPES ---

export enum KnowledgeBaseCategory {
  FULL_PROMPT = '完整复刻',
  POSE = '姿势&动作',
  SCENE = '场景&环境',
  COMPOSITION = '构图&镜头',
  LIGHTING = '光照&氛围',
  CLOTHING = '服装&造型',
  STYLE = '风格&后期',
  RETOUCH_LEARNING = 'AI修图记忆', // New Category for AI Learning
}

export interface KnowledgeBaseEntry {
  id: string;
  category: KnowledgeBaseCategory;
  promptFragment: string; // For fragments, or a title for full prompts. For Retouch: The Improvement Instruction.
  sourceImagePreview: string; 
  usageCount: number; // For tracking popularity
  fullPrompt?: { // Optional field for full replication
    consistentPrompt: string;
    variablePrompt: string;
  };
  // Field for storing the analysis logic for AI learning
  learningContext?: string;
  
  // For deletion logic
  groupId?: string; // ID linking fragments to their original full prompt analysis
  deletedAt?: number; // Timestamp if in trash, undefined if active
}

export type CategorizedKBSuggestions = {
  [key in KnowledgeBaseCategory]?: string;
};

// New type for the enhanced KB analysis response from Gemini
export interface KnowledgeBaseAnalysis {
  holistic_description: string; // The complete, coherent "motherboard" prompt
  fragments: CategorizedKBSuggestions; // The derived fragments
}

// --- SMART RETOUCH TYPES ---
export interface SmartRetouchRow {
    id: string;
    originalImage: ImageFile | null;
    analysisText: string; // The visible "Improvement Instructions"
    understandingText?: string; // The internal "Original Image Understanding"
    isAnalyzing: boolean;
    generatedImage: string | null;
    isGenerating: boolean;
    error: string | null;
}
