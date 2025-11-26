
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

export interface ConsistentElements {
  primary_subject: {
    item: string;
    key_features: string[];
    materials: string[];
    brand: string; // New field
    emotional_tone: string; // New field
  };
  scene_environment: {
    general_location: string;
    shared_elements: string[];
  };
  image_quality_and_composition: {
    style: string;
    lighting: string;
    quality: string;
    lens_type: string;
  };
}

export interface InconsistentElement {
  image_index: number;
  framing: string;
  subject_pose: string;
  person_description: string;
  unique_details: string;
  aspect_ratio: string;
  camera_settings: string; // New field
}

export interface AnalysisResult {
  consistent_elements: ConsistentElements;
  inconsistent_elements: InconsistentElement[];
}

export interface VariablePrompt {
  id: string;
  prompt: string;
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
}

export type CategorizedKBSuggestions = {
  [key in KnowledgeBaseCategory]?: string[];
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
    analysisText: string;
    isAnalyzing: boolean;
    generatedImage: string | null;
    isGenerating: boolean;
    error: string | null;
}
