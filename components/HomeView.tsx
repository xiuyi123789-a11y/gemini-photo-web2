import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon, CursorIcon, DownloadIcon, EyeIcon, EyeSlashIcon, FitViewIcon, HandIcon, HomeIcon, LayersIcon, PlusIcon, RedoIcon, TextIcon, TrashIcon, UndoIcon, UploadIcon, XIcon, ZoomInIcon, ZoomOutIcon } from './IconComponents';
import { DEFAULT_REAL_ESRGAN_PARAMS, generateWorkbenchImage, removeWatermark, retouchImageFromBase64, retouchImageFromUrl, taskChatWithGpt5, upscaleImage } from '../services/replicateService';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
};

type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
  productForm?: ProductForm;
  canvas?: CanvasSnapshot;
};

type CanvasItem = {
  id: string;
  type: 'image' | 'video' | 'text';
  src?: string;
  text?: string;
  visible?: boolean;
  opacity?: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type CanvasSnapshot = {
  panX: number;
  panY: number;
  zoom: number;
  items: CanvasItem[];
};

type ToolMode = 'select' | 'pan';

type ProductItem = {
  id: string;
  name: string;
  spec: string;
  price: string;
  selected: boolean;
};

type ProductForm = {
  platform: string;
  market: string;
  products: ProductItem[];
  details: string;
};

const uuid = () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const readJsonFromLocalStorage = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const writeJsonToLocalStorage = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
};

const normalizeCanvasSnapshot = (stored: any): CanvasSnapshot => {
  const items = Array.isArray(stored?.items)
    ? stored.items
        .map((it: any) => {
          const id = String(it?.id || '');
          const type = it?.type === 'image' || it?.type === 'video' || it?.type === 'text' ? it.type : null;
          if (!id || !type) return null;
          const x = typeof it?.x === 'number' ? it.x : 0;
          const y = typeof it?.y === 'number' ? it.y : 0;
          const width = typeof it?.width === 'number' ? it.width : 320;
          const height = typeof it?.height === 'number' ? it.height : 240;
          const visible = typeof it?.visible === 'boolean' ? it.visible : true;
          const rawOpacity = typeof it?.opacity === 'number' ? it.opacity : 1;
          const opacity = clamp(rawOpacity, 0, 1);
          const src = typeof it?.src === 'string' ? it.src : undefined;
          const text = typeof it?.text === 'string' ? it.text : undefined;
          return { id, type, src, text, visible, opacity, x, y, width, height } satisfies CanvasItem;
        })
        .filter(Boolean)
    : [];
  return {
    panX: typeof stored?.panX === 'number' ? stored.panX : 0,
    panY: typeof stored?.panY === 'number' ? stored.panY : 0,
    zoom: typeof stored?.zoom === 'number' ? stored.zoom : 1,
    items
  };
};

const createBlankProductForm = (): ProductForm => ({
  platform: '',
  market: '',
  products: [{ id: uuid(), name: '', spec: '', price: '', selected: true }],
  details: ''
});

const normalizeProductForm = (stored: any): ProductForm => {
  if (stored && Array.isArray(stored.products)) {
    const safeProducts = stored.products.length > 0 ? stored.products : [{ id: uuid(), name: '', spec: '', price: '', selected: true }];
    return {
      platform: stored.platform || '',
      market: stored.market || '',
      products: safeProducts.map((p: any) => ({
        id: p.id || uuid(),
        name: p.name || '',
        spec: p.spec || '',
        price: p.price || '',
        selected: typeof p.selected === 'boolean' ? p.selected : true
      })),
      details: stored.details || ''
    };
  }
  return createBlankProductForm();
};

const boxesOverlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
};

const findNonOverlappingPosition = (existing: CanvasItem[], w: number, h: number) => {
  const margin = 40;
  const step = 40;
  const maxCols = 80;
  const maxRows = 80;
  for (let row = 0; row < maxRows; row++) {
    for (let col = 0; col < maxCols; col++) {
      const x = col * (step + 320);
      const y = row * (step + 320);
      const nextBox = { x, y, w: w + margin, h: h + margin };
      const hit = existing.some((it) => boxesOverlap(nextBox, { x: it.x, y: it.y, w: it.width + margin, h: it.height + margin }));
      if (!hit) return { x, y };
    }
  }
  const x = existing.length * 40;
  const y = existing.length * 40;
  return { x, y };
};

const loadImageSize = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });

const loadVideoSize = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve({ width: video.videoWidth || 640, height: video.videoHeight || 360 });
    video.onerror = () => reject(new Error('Failed to load video'));
    video.src = src;
  });

const downloadUrl = async (url: string, filename: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

const PLATFORM_OPTIONS = [
  '亚马逊',
  '淘宝',
  'TEMU',
  '拼多多',
  'TikTok Shop',
  '抖音商城',
  '京东',
  '美客多',
  'OZON',
  'Walmart',
  'AliExpress',
  'Shopee',
  '唯品会',
  '自定义'
];

const MARKET_OPTIONS = [
  '美国（英语）',
  '中国（中文）',
  '西班牙（西班牙语）',
  '法国（法语）',
  '墨西哥（西班牙语）',
  '巴西（葡萄牙语）',
  '俄罗斯（俄语）',
  '德国（德语）',
  '日本（日语）',
  '韩国（韩语）',
  '自定义'
];

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n');

const formatProductInfoBlock = (form: ProductForm) => {
  const platform = form.platform.trim();
  const market = form.market.trim();
  const details = normalizeNewlines(form.details || '').trim();
  const selectedProducts = (form.products || []).filter((p) => p.selected);

  const hasAny =
    Boolean(platform) ||
    Boolean(market) ||
    Boolean(details) ||
    selectedProducts.some((p) => (p.name || '').trim() || (p.spec || '').trim() || (p.price || '').trim());

  if (!hasAny) return '';

  const lines: string[] = [];
  lines.push('【商品信息】');
  if (platform) lines.push(`电商平台：${platform}`);
  if (market) lines.push(`销售国家/语言：${market}`);

  const productLines: string[] = [];
  let productIndex = 0;
  selectedProducts.forEach((p) => {
    const name = p.name.trim();
    const spec = p.spec.trim();
    const price = p.price.trim();
    if (!name && !spec && !price) return;
    productIndex += 1;
    productLines.push(`商品${productIndex}：${name || '未命名'}`);
    productLines.push(`规格：${spec || '-'}`);
    productLines.push(`价格：${price || '-'}`);
  });

  if (productLines.length > 0) {
    lines.push('');
    lines.push(...productLines);
  }

  if (details) {
    lines.push('');
    lines.push('商品详情（卖点/尺寸/场景）：');
    lines.push(details);
  }

  return lines.join('\n').trim();
};

export const HomeView: React.FC<{ onStageChange?: (stage: 'init' | 'workbench') => void }> = ({ onStageChange }) => {
  const [stage, setStage] = useState<'init' | 'workbench'>(() => {
    const raw = localStorage.getItem('ql_home_stage');
    return raw === 'workbench' ? 'workbench' : 'init';
  });
  const [draft, setDraft] = useState('');
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isUploadDragOver, setIsUploadDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [productForm, setProductForm] = useState<ProductForm>(() => {
    const stored = readJsonFromLocalStorage<ProductForm | null>('ql_home_product_form', null);
    if (stored) return normalizeProductForm(stored);
    const legacy = localStorage.getItem('ql_home_product_info') || '';
    return normalizeProductForm({ details: legacy, products: [{ id: uuid(), name: '', spec: '', price: '', selected: true }] });
  });
  const [isProductInfoOpen, setIsProductInfoOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const pendingImageUrlMapRef = useRef<Map<string, string>>(new Map());
  const pendingImagePreviews = useMemo(() => {
    const map = pendingImageUrlMapRef.current;
    const keep = new Set<string>();
    const next = pendingImages.map((file, idx) => {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      keep.add(key);
      const existing = map.get(key);
      const url = existing || URL.createObjectURL(file);
      if (!existing) map.set(key, url);
      return { key, url, file, idx };
    });
    for (const [key, url] of map.entries()) {
      if (keep.has(key)) continue;
      URL.revokeObjectURL(url);
      map.delete(key);
    }
    return next;
  }, [pendingImages]);

  useEffect(() => {
    return () => {
      for (const url of pendingImageUrlMapRef.current.values()) {
        URL.revokeObjectURL(url);
      }
      pendingImageUrlMapRef.current.clear();
    };
  }, []);

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const activeId = localStorage.getItem('ql_home_active_session') || null;
    const raw = readJsonFromLocalStorage<any[]>('ql_home_sessions', []);
    const legacyCanvas = normalizeCanvasSnapshot(readJsonFromLocalStorage<any>('ql_home_canvas', null));
    const legacyProductForm = normalizeProductForm(readJsonFromLocalStorage<any>('ql_home_product_form', null));
    return raw.map((s) => {
      const id = String(s?.id || uuid());
      const productForm = normalizeProductForm(s?.productForm ?? (activeId && id === activeId ? legacyProductForm : null));
      const canvas = normalizeCanvasSnapshot(s?.canvas ?? (activeId && id === activeId ? legacyCanvas : null));
      return {
        id,
        title: String(s?.title || '新会话'),
        createdAt: typeof s?.createdAt === 'number' ? s.createdAt : Date.now(),
        messages: Array.isArray(s?.messages) ? s.messages : [],
        productForm,
        canvas
      };
    });
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => localStorage.getItem('ql_home_active_session') || null);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>(() => {
    const raw = readJsonFromLocalStorage<any>('ql_home_open_sessions', null);
    const list = Array.isArray(raw) ? raw.map((v) => String(v)).filter(Boolean) : [];
    const activeId = localStorage.getItem('ql_home_active_session') || null;
    if (activeId && !list.includes(activeId)) return [activeId, ...list];
    return list;
  });
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const sessionsRef = useRef<ChatSession[]>(sessions);
  const openSessionIdsRef = useRef<string[]>(openSessionIds);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    openSessionIdsRef.current = openSessionIds;
  }, [openSessionIds]);

  const activeSession = useMemo(() => sessions.find((s) => s.id === activeSessionId) || null, [sessions, activeSessionId]);
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s] as const)), [sessions]);

  const [toolMode, setToolMode] = useState<ToolMode>('select');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [present, setPresent] = useState<CanvasSnapshot>(() => {
    const stored = readJsonFromLocalStorage<any>('ql_home_canvas', null);
    return normalizeCanvasSnapshot(stored);
  });
  const pastRef = useRef<CanvasSnapshot[]>([]);
  const futureRef = useRef<CanvasSnapshot[]>([]);

  const beginHistory = useCallback(() => {
    pastRef.current = [...pastRef.current, present];
    futureRef.current = [];
  }, [present]);

  const flushPresentToStorage = useCallback(() => {
    setPresent((prev) => {
      writeJsonToLocalStorage('ql_home_canvas', prev);
      return prev;
    });
  }, []);

  const commit = useCallback((updater: (prev: CanvasSnapshot) => CanvasSnapshot) => {
    setPresent((prev) => {
      const next = updater(prev);
      pastRef.current = [...pastRef.current, prev];
      futureRef.current = [];
      writeJsonToLocalStorage('ql_home_canvas', next);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPresent((prev) => {
      const past = pastRef.current;
      if (past.length === 0) return prev;
      const next = past[past.length - 1];
      pastRef.current = past.slice(0, -1);
      futureRef.current = [prev, ...futureRef.current];
      writeJsonToLocalStorage('ql_home_canvas', next);
      return next;
    });
  }, []);

  const redo = useCallback(() => {
    setPresent((prev) => {
      const future = futureRef.current;
      if (future.length === 0) return prev;
      const next = future[0];
      futureRef.current = future.slice(1);
      pastRef.current = [...pastRef.current, prev];
      writeJsonToLocalStorage('ql_home_canvas', next);
      return next;
    });
  }, []);

  useEffect(() => {
    writeJsonToLocalStorage('ql_home_sessions', sessions);
  }, [sessions]);

  useEffect(() => {
    if (activeSessionId) localStorage.setItem('ql_home_active_session', activeSessionId);
    else localStorage.removeItem('ql_home_active_session');
  }, [activeSessionId]);

  useEffect(() => {
    writeJsonToLocalStorage('ql_home_open_sessions', openSessionIds);
  }, [openSessionIds]);

  useEffect(() => {
    setOpenSessionIds((prev) => prev.filter((id) => sessions.some((s) => s.id === id)));
  }, [sessions]);

  useEffect(() => {
    if (activeSessionId) return;
    if (openSessionIds.length === 0) return;
    setActiveSessionId(openSessionIds[0]);
  }, [activeSessionId, openSessionIds]);

  useEffect(() => {
    localStorage.setItem('ql_home_stage', stage);
  }, [stage]);

  useEffect(() => {
    onStageChange?.(stage);
  }, [onStageChange, stage]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      writeJsonToLocalStorage('ql_home_product_form', productForm);
    }, 200);
    return () => window.clearTimeout(t);
  }, [productForm]);

  const productInfoBlock = useMemo(() => formatProductInfoBlock(productForm), [productForm]);
  const hasProductInfo = productInfoBlock.trim().length > 0;
  const composeInput = useCallback(
    (extraText: string) => {
      const parts: string[] = [];
      if (hasProductInfo) parts.push(productInfoBlock.trim());
      const extra = extraText.trim();
      if (extra) {
        parts.push('【用户补充】');
        parts.push(extra);
      }
      return parts.join('\n');
    },
    [hasProductInfo, productInfoBlock]
  );

  const composedInputPreview = useMemo(() => {
    const parts: string[] = [];
    if (hasProductInfo) parts.push(productInfoBlock.trim());
    const extra = draft.trim();
    if (extra) {
      parts.push('【用户补充】');
      parts.push(extra);
    }
    return parts.join('\n');
  }, [draft, hasProductInfo, productInfoBlock]);

  const tryParseJsonFromText = useCallback((text: string) => {
    const raw = (text || '').trim();
    if (!raw) return null;
    const stripped = raw.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(stripped) as any;
    } catch {
      return null;
    }
  }, []);

  const isSessionBlank = useCallback((session: ChatSession) => {
    const hasUserMessage = session.messages.some((m) => m.role === 'user' && m.content.trim());
    if (hasUserMessage) return false;
    const itemsCount = session.canvas?.items?.length ?? 0;
    if (itemsCount > 0) return false;
    if (session.messages.length !== 1) return false;
    const first = session.messages[0];
    if (!first || first.role !== 'assistant') return false;
    const text = (first.content || '').trim();
    if (!text) return true;
    return text.includes('新会话已开启') || text.includes('你好，我在这里帮你');
  }, []);

  const openSessionWindow = useCallback((sessionId: string) => {
    setOpenSessionIds((prev) => {
      if (prev.includes(sessionId)) return prev;
      return [sessionId, ...prev];
    });
    setActiveSessionId(sessionId);
  }, []);

  const closeSessionWindow = useCallback(
    (sessionId: string) => {
      const target = sessionsRef.current.find((s) => s.id === sessionId) || null;
      const shouldDelete = target ? isSessionBlank(target) : false;

      setOpenSessionIds((prev) => {
        const next = prev.filter((id) => id !== sessionId);
        setActiveSessionId((cur) => {
          if (cur !== sessionId) return cur;
          return next[0] ?? null;
        });
        if (next.length === 0) setStage('init');
        return next;
      });

      if (shouldDelete) setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    },
    [isSessionBlank]
  );

  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessionsRef.current.find((s) => s.id === activeSessionId) || null;
    const next = session?.canvas || { panX: 0, panY: 0, zoom: 1, items: [] };
    setPresent(next);
    pastRef.current = [];
    futureRef.current = [];
    setSelectedIds(new Set());
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) return;
    const t = window.setTimeout(() => {
      setSessions((prev) => prev.map((s) => (s.id === activeSessionId ? { ...s, canvas: present } : s)));
    }, 200);
    return () => window.clearTimeout(t);
  }, [activeSessionId, present]);

  const setPlatform = useCallback((platform: string) => {
    setProductForm((prev) => ({ ...prev, platform }));
  }, []);

  const setMarket = useCallback((market: string) => {
    setProductForm((prev) => ({ ...prev, market }));
  }, []);

  const setDetails = useCallback((details: string) => {
    setProductForm((prev) => ({ ...prev, details }));
  }, []);

  const addProduct = useCallback(() => {
    setProductForm((prev) => ({
      ...prev,
      products: [...prev.products, { id: uuid(), name: '', spec: '', price: '', selected: true }]
    }));
  }, []);

  const removeProduct = useCallback((id: string) => {
    setProductForm((prev) => {
      const nextProducts = prev.products.filter((p) => p.id !== id);
      if (nextProducts.length === 0) return { ...prev, products: [{ id: uuid(), name: '', spec: '', price: '', selected: true }] };
      return { ...prev, products: nextProducts };
    });
  }, []);

  const toggleProductSelected = useCallback((id: string) => {
    setProductForm((prev) => ({
      ...prev,
      products: prev.products.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p))
    }));
  }, []);

  const updateProduct = useCallback((id: string, patch: Partial<Pick<ProductItem, 'name' | 'spec' | 'price'>>) => {
    setProductForm((prev) => ({
      ...prev,
      products: prev.products.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }));
  }, []);

  const ensureSession = useCallback(() => {
    if (activeSessionId && sessions.some((s) => s.id === activeSessionId)) return activeSessionId;
    const id = uuid();
    const next: ChatSession = {
      id,
      title: '新会话',
      createdAt: Date.now(),
      messages: [
        {
          id: uuid(),
          role: 'assistant',
          content: '你好，我在这里帮你把需求拆解成可执行的电商套图任务，并把素材放到画布里。',
          createdAt: Date.now()
        }
      ],
      canvas: { panX: 0, panY: 0, zoom: 1, items: [] }
    };
    setSessions((prev) => [next, ...prev]);
    openSessionWindow(id);
    return id;
  }, [activeSessionId, openSessionWindow, sessions]);

  const appendMessage = useCallback((sessionId: string, message: ChatMessage) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, messages: [...s.messages, message] } : s))
    );
  }, []);

  const updateMessage = useCallback((sessionId: string, messageId: string, updater: (prev: ChatMessage) => ChatMessage) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        return { ...s, messages: s.messages.map((m) => (m.id === messageId ? updater(m) : m)) };
      })
    );
  }, []);

  const createNewSession = useCallback(() => {
    const id = uuid();
    const next: ChatSession = {
      id,
      title: '新会话',
      createdAt: Date.now(),
      messages: [
        {
          id: uuid(),
          role: 'assistant',
          content: '新会话已开启。你可以继续上传素材或描述要生成的套图需求。',
          createdAt: Date.now()
        }
      ],
      canvas: { panX: 0, panY: 0, zoom: 1, items: [] }
    };
    setSessions((prev) => [next, ...prev]);
    openSessionWindow(id);
    setSelectedIds(new Set());
  }, [openSessionWindow]);

  const importAssets = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      const nextItems: CanvasItem[] = [];
      for (const file of list) {
        const url = URL.createObjectURL(file);
        if (file.type.startsWith('image/')) {
          const size = await loadImageSize(url);
          nextItems.push({
            id: uuid(),
            type: 'image',
            src: url,
            visible: true,
            opacity: 1,
            width: size.width,
            height: size.height,
            x: 0,
            y: 0
          });
        } else if (file.type.startsWith('video/')) {
          const size = await loadVideoSize(url);
          nextItems.push({
            id: uuid(),
            type: 'video',
            src: url,
            visible: true,
            opacity: 1,
            width: size.width,
            height: size.height,
            x: 0,
            y: 0
          });
        } else {
          URL.revokeObjectURL(url);
        }
      }

      if (nextItems.length === 0) return [];

      let addedItems: CanvasItem[] = [];
      commit((prev) => {
        const positioned = nextItems.map((it) => {
          const pos = findNonOverlappingPosition(prev.items, it.width, it.height);
          return { ...it, x: pos.x, y: pos.y };
        });
        addedItems = positioned;
        return { ...prev, items: [...prev.items, ...positioned] };
      });
      return addedItems;
    },
    [commit]
  );

  const openUpload = useCallback(() => {
    setIsUploadOpen(true);
  }, []);

  const closeUpload = useCallback(() => {
    setIsUploadOpen(false);
    setIsUploadDragOver(false);
  }, []);

  const addPendingFromFiles = useCallback((files: File[]) => {
    const media = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    const others = files.filter((f) => !(f.type.startsWith('image/') || f.type.startsWith('video/')));
    if (media.length > 0) setPendingImages((prev) => [...prev, ...media]);
    if (others.length > 0) setPendingFiles((prev) => [...prev, ...others]);
  }, []);

  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      addPendingFromFiles(files);
    },
    [addPendingFromFiles]
  );

  const handleSendFromInit = useCallback(async () => {
    const text = draft.trim();
    if (!text && pendingImages.length === 0 && pendingFiles.length === 0 && !hasProductInfo) return;
    const sessionId = ensureSession();
    const fullText = composeInput(text);
    if (fullText) {
      appendMessage(sessionId, { id: uuid(), role: 'user', content: fullText, createdAt: Date.now() });
      setDraft('');
    }
    if (pendingFiles.length > 0) {
      appendMessage(sessionId, {
        id: uuid(),
        role: 'user',
        content: `【已上传文件】\n${pendingFiles.map((f) => `${f.name} (${Math.ceil(f.size / 1024)} KB)`).join('\n')}`,
        createdAt: Date.now()
      });
      setPendingFiles([]);
    }
    if (pendingImages.length > 0) {
      await importAssets(pendingImages);
      setPendingImages([]);
    }
    setStage('workbench');
  }, [appendMessage, composeInput, draft, ensureSession, hasProductInfo, importAssets, pendingFiles, pendingImages]);

  const [chatInput, setChatInput] = useState('');
  const [isWorkbenchAiRunning, setIsWorkbenchAiRunning] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isWorkbenchImageUploadOpen, setIsWorkbenchImageUploadOpen] = useState(false);
  const [isWorkbenchFileUploadOpen, setIsWorkbenchFileUploadOpen] = useState(false);
  const [isWorkbenchImageDragOver, setIsWorkbenchImageDragOver] = useState(false);
  const [isWorkbenchFileDragOver, setIsWorkbenchFileDragOver] = useState(false);
  const workbenchImageInputRef = useRef<HTMLInputElement | null>(null);
  const workbenchFileInputRef = useRef<HTMLInputElement | null>(null);
  const workbenchAbortRef = useRef<AbortController | null>(null);
  const workbenchRunIdRef = useRef(0);
  const lastWorkbenchSendRef = useRef<{ text: string } | null>(null);

  const [chatContextMenu, setChatContextMenu] = useState<null | {
    x: number;
    y: number;
    messageId: string;
    content: string;
    pasteText: string;
  }>(null);
  const chatMessageElMapRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const closeChatContextMenu = useCallback(() => setChatContextMenu(null), []);

  useEffect(() => {
    if (!chatContextMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatContextMenu(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatContextMenu]);

  const cancelWorkbenchAi = useCallback(() => {
    const controller = workbenchAbortRef.current;
    if (!controller) return;
    if (!controller.signal.aborted) controller.abort();
  }, []);

  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [activeSession?.messages.length, stage]);

  const handleSendInWorkbench = useCallback(() => {
    if (isWorkbenchAiRunning) return;
    const text = chatInput.trim();
    if (!text) return;
    const sessionId = ensureSession();
    const fullPrompt = composeInput(text);
    lastWorkbenchSendRef.current = { text: chatInput };
    appendMessage(sessionId, { id: uuid(), role: 'user', content: fullPrompt, createdAt: Date.now() });
    setChatInput('');
    const assistantId = uuid();
    appendMessage(sessionId, {
      id: assistantId,
      role: 'assistant',
      content: '正在理解需求…',
      createdAt: Date.now()
    });

    const runId = (workbenchRunIdRef.current += 1);
    const abortController = new AbortController();
    workbenchAbortRef.current = abortController;
    setIsWorkbenchAiRunning(true);

    void (async () => {
      try {
        const baseMessages = (activeSession?.messages || []).slice(-14);
        const taskMessages = baseMessages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content }));
        taskMessages.push({ role: 'user', content: fullPrompt });

        const modelText = await taskChatWithGpt5(taskMessages, {
          reasoningEffort: 'minimal',
          verbosity: 'low',
          retry: { signal: abortController.signal }
        });
        const parsed = tryParseJsonFromText(modelText);

        if (!parsed || typeof parsed !== 'object') {
          updateMessage(sessionId, assistantId, (m) => ({ ...m, content: modelText }));
          return;
        }

        const type = String((parsed as any).type || '');
        if (type === 'clarify') {
          const question = String((parsed as any).question || '').trim() || modelText;
          updateMessage(sessionId, assistantId, (m) => ({ ...m, content: question }));
          return;
        }

        const nextPrompt = String((parsed as any).prompt || '').trim() || fullPrompt;
        const aspectRatio = String((parsed as any).aspect_ratio || '').trim() || '3:4';

        updateMessage(sessionId, assistantId, (m) => ({ ...m, content: '收到，正在生成中…' }));

        const referenceImages = present.items
          .filter((it) => it.type === 'image' && it.src)
          .filter((it) => selectedIds.size === 0 || selectedIds.has(it.id))
          .map((it) => it.src!) as string[];

        const url = await generateWorkbenchImage(nextPrompt, referenceImages, aspectRatio, { signal: abortController.signal });
        const size = await loadImageSize(url);
        commit((prev) => {
          const pos = findNonOverlappingPosition(prev.items, size.width, size.height);
          const nextItem: CanvasItem = {
            id: uuid(),
            type: 'image',
            src: url,
            visible: true,
            opacity: 1,
            width: size.width,
            height: size.height,
            x: pos.x,
            y: pos.y
          };
          return { ...prev, items: [...prev.items, nextItem] };
        });
        updateMessage(sessionId, assistantId, (m) => ({ ...m, content: '已生成 1 张图片，并自动载入到画布中。你可以继续描述下一张需求。' }));
      } catch (error) {
        const isAbort = error instanceof DOMException && error.name === 'AbortError';
        if (isAbort) {
          updateMessage(sessionId, assistantId, (m) => ({ ...m, content: '已取消' }));
          const last = lastWorkbenchSendRef.current?.text ?? '';
          setChatInput(last);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        updateMessage(sessionId, assistantId, (m) => ({ ...m, content: `生成失败：${message}` }));
      } finally {
        if (workbenchRunIdRef.current !== runId) return;
        if (workbenchAbortRef.current === abortController) workbenchAbortRef.current = null;
        setIsWorkbenchAiRunning(false);
      }
    })();
  }, [
    activeSession?.messages,
    appendMessage,
    chatInput,
    commit,
    composeInput,
    ensureSession,
    isWorkbenchAiRunning,
    present.items,
    selectedIds,
    tryParseJsonFromText,
    updateMessage
  ]);

  const [panelCollapsed, setPanelCollapsed] = useState(() => localStorage.getItem('ql_home_panel_collapsed') === '1');
  const [panelWidth, setPanelWidth] = useState(() => Number(localStorage.getItem('ql_home_panel_width')) || 360);
  const [panelHeight, setPanelHeight] = useState(() => Number(localStorage.getItem('ql_home_panel_height')) || 560);
  const [chatComposerHeight, setChatComposerHeight] = useState(() => Number(localStorage.getItem('ql_home_chat_composer_height')) || 170);

  useEffect(() => {
    localStorage.setItem('ql_home_panel_collapsed', panelCollapsed ? '1' : '0');
  }, [panelCollapsed]);
  useEffect(() => {
    localStorage.setItem('ql_home_panel_width', String(panelWidth));
  }, [panelWidth]);
  useEffect(() => {
    localStorage.setItem('ql_home_panel_height', String(panelHeight));
  }, [panelHeight]);
  useEffect(() => {
    localStorage.setItem('ql_home_chat_composer_height', String(chatComposerHeight));
  }, [chatComposerHeight]);

  const widthDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const heightDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const composerHeightDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const startWidthDrag = useCallback((e: React.PointerEvent) => {
    if (panelCollapsed) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    widthDragRef.current = { startX: e.clientX, startWidth: panelWidth };
  }, [panelCollapsed, panelWidth]);

  const startHeightDrag = useCallback((e: React.PointerEvent) => {
    if (panelCollapsed) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    heightDragRef.current = { startY: e.clientY, startHeight: panelHeight };
  }, [panelCollapsed, panelHeight]);

  const startComposerHeightDrag = useCallback((e: React.PointerEvent) => {
    if (panelCollapsed) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    composerHeightDragRef.current = { startY: e.clientY, startHeight: chatComposerHeight };
  }, [chatComposerHeight, panelCollapsed]);

  const onPanelPointerMove = useCallback((e: React.PointerEvent) => {
    if (widthDragRef.current) {
      const dx = e.clientX - widthDragRef.current.startX;
      const next = clamp(widthDragRef.current.startWidth + dx, 280, 720);
      setPanelWidth(next);
    }
    if (heightDragRef.current) {
      const dy = e.clientY - heightDragRef.current.startY;
      const next = clamp(heightDragRef.current.startHeight + dy, 320, 900);
      setPanelHeight(next);
    }
    if (composerHeightDragRef.current) {
      const dy = e.clientY - composerHeightDragRef.current.startY;
      const maxHeight = Math.max(140, panelHeight - 140);
      const next = clamp(composerHeightDragRef.current.startHeight - dy, 120, maxHeight);
      setChatComposerHeight(next);
    }
  }, [panelHeight]);

  const onPanelPointerUp = useCallback(() => {
    widthDragRef.current = null;
    heightDragRef.current = null;
    composerHeightDragRef.current = null;
  }, []);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasHoveredRef = useRef(false);
  const toolModeRef = useRef<ToolMode>(toolMode);
  const stageRef = useRef(stage);
  const spacePrevToolRef = useRef<ToolMode>('select');
  const spaceHeldRef = useRef(false);
  useEffect(() => {
    toolModeRef.current = toolMode;
  }, [toolMode]);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);
  const dragRef = useRef<
    | null
    | { kind: 'pan'; startX: number; startY: number; startPanX: number; startPanY: number }
    | {
        kind: 'item';
        pointerId: number;
        startX: number;
        startY: number;
        startZoom: number;
        itemIds: string[];
        startPositions: Record<string, { x: number; y: number }>;
      }
  >(null);

  const getCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const x = (clientX - rect.left - present.panX) / present.zoom;
    const y = (clientY - rect.top - present.panY) / present.zoom;
    return { x, y };
  }, [present.panX, present.panY, present.zoom]);

  const zoomMin = 0.000001;
  const zoomMax = 1000000;

  const applyZoomAtCanvasPoint = useCallback(
    (nextZoomRaw: number, canvasX: number, canvasY: number) => {
      const prevZoom = present.zoom || 1;
      const nextZoom = clamp(nextZoomRaw, zoomMin, zoomMax);
      const worldX = (canvasX - present.panX) / prevZoom;
      const worldY = (canvasY - present.panY) / prevZoom;
      const nextPanX = canvasX - worldX * nextZoom;
      const nextPanY = canvasY - worldY * nextZoom;
      setPresent((prev) => ({ ...prev, zoom: nextZoom, panX: nextPanX, panY: nextPanY }));
    },
    [present.panX, present.panY, present.zoom]
  );

  const onCanvasWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const prevZoom = present.zoom || 1;
      const nextZoom = prevZoom * (e.deltaY > 0 ? 0.9 : 1.1);
      applyZoomAtCanvasPoint(nextZoom, cx, cy);
    },
    [applyZoomAtCanvasPoint, present.zoom]
  );

  const [zoomInput, setZoomInput] = useState('100');
  const zoomEditingRef = useRef(false);
  useEffect(() => {
    if (zoomEditingRef.current) return;
    const pct = Math.round((present.zoom || 1) * 100);
    setZoomInput(String(pct));
  }, [present.zoom]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (e.repeat) return;
      if (stageRef.current !== 'workbench') return;
      if (!canvasHoveredRef.current) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) return;
      if (spaceHeldRef.current) return;
      spaceHeldRef.current = true;
      spacePrevToolRef.current = toolModeRef.current;
      setToolMode('pan');
      e.preventDefault();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (!spaceHeldRef.current) return;
      spaceHeldRef.current = false;
      setToolMode(spacePrevToolRef.current || 'select');
      if (dragRef.current?.kind === 'pan') {
        dragRef.current = null;
        flushPresentToStorage();
      }
      e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [flushPresentToStorage]);

  const onCanvasBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (toolMode !== 'pan') {
        setSelectedIds(new Set());
        return;
      }
      beginHistory();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      dragRef.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, startPanX: present.panX, startPanY: present.panY };
      setSelectedIds(new Set());
    },
    [beginHistory, present.panX, present.panY, toolMode]
  );

  const onCanvasPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === 'pan') {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        setPresent((prev) => ({ ...prev, panX: drag.startPanX + dx, panY: drag.startPanY + dy }));
        return;
      }
      if (drag.kind === 'item') {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const factor = drag.startZoom || 1;
        setPresent((prev) => ({
          ...prev,
          items: prev.items.map((it) => {
            const start = drag.startPositions[it.id];
            if (!start) return it;
            return { ...it, x: start.x + dx / factor, y: start.y + dy / factor };
          })
        }));
      }
    },
    []
  );

  const onCanvasPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === 'pan') {
      flushPresentToStorage();
      return;
    }
    if (drag.kind === 'item') {
      flushPresentToStorage();
    }
  }, [flushPresentToStorage]);

  const onItemPointerDown = useCallback(
    (e: React.PointerEvent, itemId: string) => {
      if (e.button !== 0) return;
      if (toolMode === 'pan') return;
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      const nextSelected = (() => {
        if (e.shiftKey) {
          const next = new Set(selectedIds);
          if (next.has(itemId)) next.delete(itemId);
          else next.add(itemId);
          return next;
        }
        if (selectedIds.has(itemId)) return new Set(selectedIds);
        return new Set([itemId]);
      })();
      setSelectedIds(nextSelected);

      const itemIds = Array.from(nextSelected);
      const startPositions: Record<string, { x: number; y: number }> = {};
      for (const it of present.items) {
        if (!nextSelected.has(it.id)) continue;
        startPositions[it.id] = { x: it.x, y: it.y };
      }

      beginHistory();
      dragRef.current = {
        kind: 'item',
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startZoom: present.zoom,
        itemIds,
        startPositions
      };
    },
    [beginHistory, present.items, present.zoom, selectedIds, toolMode]
  );

  const handleAddText = useCallback(() => {
    const center = canvasRef.current?.getBoundingClientRect();
    const cx = center ? center.left + center.width / 2 : 0;
    const cy = center ? center.top + center.height / 2 : 0;
    const p = getCanvasPoint(cx, cy);
    const item: CanvasItem = {
      id: uuid(),
      type: 'text',
      text: '双击编辑文字',
      visible: true,
      opacity: 1,
      x: p.x,
      y: p.y,
      width: 320,
      height: 60
    };
    commit((prev) => ({ ...prev, items: [...prev.items, item] }));
    setSelectedIds(new Set([item.id]));
  }, [commit, getCanvasPoint]);

  const handleDownloadSelection = useCallback(async () => {
    const selected = present.items.filter((it) => selectedIds.has(it.id)).filter((it) => it.type === 'image' || it.type === 'video');
    for (const it of selected) {
      if (!it.src) continue;
      const ext = it.type === 'video' ? 'mp4' : 'png';
      await downloadUrl(it.src, `quantumleap_${it.id}.${ext}`);
      await new Promise<void>((r) => window.setTimeout(r, 80));
    }
  }, [present.items, selectedIds]);

  const downloadCanvasItem = useCallback(async (it: CanvasItem) => {
    if (!it.src) return;
    if (it.type !== 'image' && it.type !== 'video') return;
    const ext = it.type === 'video' ? 'mp4' : 'png';
    await downloadUrl(it.src, `quantumleap_${it.id}.${ext}`);
  }, []);

  const addCanvasItemToChat = useCallback(
    (it: CanvasItem) => {
      const sessionId = ensureSession();
      const lines: string[] = ['【画布选中内容】'];
      if (it.type === 'text') lines.push(it.text || '');
      if ((it.type === 'image' || it.type === 'video') && it.src) lines.push(it.src);
      appendMessage(sessionId, { id: uuid(), role: 'user', content: lines.join('\n'), createdAt: Date.now() });
    },
    [appendMessage, ensureSession]
  );

  const panelOuterHeight = panelCollapsed ? 44 : panelHeight;
  const downloadableSelectedCount = present.items.filter((it) => selectedIds.has(it.id) && (it.type === 'image' || it.type === 'video')).length;

  const singleSelectedId = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    return Array.from(selectedIds)[0] || null;
  }, [selectedIds]);

  const singleSelectedItem = useMemo(() => {
    if (!singleSelectedId) return null;
    return present.items.find((it) => it.id === singleSelectedId) || null;
  }, [present.items, singleSelectedId]);

  const [isLayersOpen, setIsLayersOpen] = useState(false);
  const [isActionsDockOpen, setIsActionsDockOpen] = useState(false);

  useEffect(() => {
    setIsActionsDockOpen(selectedIds.size > 0);
  }, [selectedIds.size]);

  useEffect(() => {
    if (!isLayersOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-ql-layers-panel="1"]')) return;
      setIsLayersOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [isLayersOpen]);

  const zoomAtCanvasCenter = useCallback(
    (nextZoom: number) => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      applyZoomAtCanvasPoint(nextZoom, rect.width / 2, rect.height / 2);
    },
    [applyZoomAtCanvasPoint]
  );

  const applyZoomPercent = useCallback(
    (percent: number) => {
      const clamped = clamp(percent, 0.01, 100000000);
      zoomAtCanvasCenter(clamped / 100);
    },
    [zoomAtCanvasCenter]
  );

  const fitToContent = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const visibleItems = present.items.filter((it) => it.visible !== false);
    if (visibleItems.length === 0) {
      setPresent((prev) => ({ ...prev, panX: 0, panY: 0, zoom: 1 }));
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const it of visibleItems) {
      minX = Math.min(minX, it.x);
      minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + it.width);
      maxY = Math.max(maxY, it.y + it.height);
    }
    const boxW = Math.max(1, maxX - minX);
    const boxH = Math.max(1, maxY - minY);
    const pad = 48;
    const zoom = clamp(Math.min((rect.width - pad * 2) / boxW, (rect.height - pad * 2) / boxH), zoomMin, zoomMax);
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const centerX = minX + boxW / 2;
    const centerY = minY + boxH / 2;
    const nextPanX = cx - centerX * zoom;
    const nextPanY = cy - centerY * zoom;
    setPresent((prev) => ({ ...prev, zoom, panX: nextPanX, panY: nextPanY }));
  }, [present.items, zoomMax, zoomMin]);

  const toggleLayerVisible = useCallback(
    (itemId: string) => {
      commit((prev) => {
        const nextItems = prev.items.map((it) => (it.id === itemId ? { ...it, visible: it.visible === false } : it));
        return { ...prev, items: nextItems };
      });
      setSelectedIds((prev) => {
        if (!prev.has(itemId)) return prev;
        return new Set();
      });
    },
    [commit]
  );

  const moveLayerToIndex = useCallback(
    (itemId: string, nextIndex: number) => {
      commit((prev) => {
        const curIndex = prev.items.findIndex((it) => it.id === itemId);
        if (curIndex === -1) return prev;
        const clampedIndex = clamp(nextIndex, 0, Math.max(0, prev.items.length - 1));
        if (clampedIndex === curIndex) return prev;
        const nextItems = [...prev.items];
        const [moved] = nextItems.splice(curIndex, 1);
        nextItems.splice(clampedIndex, 0, moved);
        return { ...prev, items: nextItems };
      });
    },
    [commit]
  );

  const layerReorderRef = useRef<{ itemId: string } | null>(null);
  const onLayerReorderPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = layerReorderRef.current;
      if (!drag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const row = el?.closest?.('[data-ql-layer-row="1"]') as HTMLElement | null;
      const targetId = row?.dataset?.layerId || null;
      if (!targetId || targetId === drag.itemId) return;
      const targetIndex = present.items.findIndex((it) => it.id === targetId);
      if (targetIndex === -1) return;
      moveLayerToIndex(drag.itemId, targetIndex);
    },
    [moveLayerToIndex, present.items]
  );

  const stopLayerReorder = useCallback(() => {
    layerReorderRef.current = null;
    window.removeEventListener('pointermove', onLayerReorderPointerMove);
    window.removeEventListener('pointerup', stopLayerReorder);
  }, [onLayerReorderPointerMove]);

  const startLayerReorder = useCallback(
    (e: React.PointerEvent, itemId: string) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      layerReorderRef.current = { itemId };
      window.addEventListener('pointermove', onLayerReorderPointerMove);
      window.addEventListener('pointerup', stopLayerReorder);
    },
    [onLayerReorderPointerMove, stopLayerReorder]
  );

  const [opacityInput, setOpacityInput] = useState('100');
  const opacityEditingRef = useRef(false);
  const opacityDragRef = useRef<{ startX: number; startValue: number } | null>(null);
  useEffect(() => {
    if (opacityEditingRef.current) return;
    const pct = Math.round(((singleSelectedItem?.opacity ?? 1) * 100) as number);
    setOpacityInput(String(pct));
  }, [singleSelectedItem?.id, singleSelectedItem?.opacity]);

  const applyOpacityPercent = useCallback(
    (pctRaw: number) => {
      if (!singleSelectedId) return;
      const pct = clamp(Math.round(pctRaw), 0, 100);
      const opacity = pct / 100;
      commit((prev) => ({
        ...prev,
        items: prev.items.map((it) => (it.id === singleSelectedId ? { ...it, opacity } : it))
      }));
    },
    [commit, singleSelectedId]
  );

  const onOpacityPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = opacityDragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const next = drag.startValue + dx * 0.5;
      applyOpacityPercent(next);
    },
    [applyOpacityPercent]
  );

  const stopOpacityDrag = useCallback(() => {
    opacityDragRef.current = null;
    window.removeEventListener('pointermove', onOpacityPointerMove);
    window.removeEventListener('pointerup', stopOpacityDrag);
  }, [onOpacityPointerMove]);

  const startOpacityDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!singleSelectedId) return;
      const startValue = Number(opacityInput);
      if (!Number.isFinite(startValue)) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      opacityDragRef.current = { startX: e.clientX, startValue };
      window.addEventListener('pointermove', onOpacityPointerMove);
      window.addEventListener('pointerup', stopOpacityDrag);
    },
    [onOpacityPointerMove, opacityInput, singleSelectedId, stopOpacityDrag]
  );

  const commitZoomInput = useCallback(() => {
    zoomEditingRef.current = false;
    const parsed = Number(String(zoomInput || '').trim());
    if (!Number.isFinite(parsed)) {
      setZoomInput(String(Math.round((present.zoom || 1) * 100)));
      return;
    }
    applyZoomPercent(parsed);
  }, [applyZoomPercent, present.zoom, zoomInput]);

  const onZoomInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    zoomEditingRef.current = true;
    setZoomInput(e.target.value.replace(/[^\d.]/g, ''));
  }, []);

  const commitOpacityInput = useCallback(() => {
    opacityEditingRef.current = false;
    const parsed = Number(String(opacityInput || '').trim());
    if (!Number.isFinite(parsed)) {
      setOpacityInput(String(Math.round((singleSelectedItem?.opacity ?? 1) * 100)));
      return;
    }
    applyOpacityPercent(parsed);
  }, [applyOpacityPercent, opacityInput, singleSelectedItem?.opacity]);

  const deleteSelectedCanvasItems = useCallback(() => {
    if (selectedIds.size === 0) return;
    const deleting = new Set(selectedIds);
    commit((prev) => ({ ...prev, items: prev.items.filter((it) => !deleting.has(it.id)) }));
    setSelectedIds(new Set());
  }, [commit, selectedIds]);

  const replaceCanvasImage = useCallback(
    (itemId: string, src: string, nextW: number, nextH: number) => {
      commit((prev) => {
        const nextItems = prev.items.map((it) => {
          if (it.id !== itemId) return it;
          const cx = it.x + it.width / 2;
          const cy = it.y + it.height / 2;
          return { ...it, src, type: 'image', visible: true, x: cx - nextW / 2, y: cy - nextH / 2, width: nextW, height: nextH };
        });
        return { ...prev, items: nextItems };
      });
    },
    [commit]
  );

  const loadImageAsBitmap = useCallback(async (src: string) => {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`加载失败：${response.status} ${response.statusText}`);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  }, []);

  const buildOutpaintInputs = useCallback(
    async (src: string, scale: number) => {
      const bitmap = await loadImageAsBitmap(src);
      const baseW = bitmap.width || 1;
      const baseH = bitmap.height || 1;
      const nextW = Math.max(1, Math.round(baseW * scale));
      const nextH = Math.max(1, Math.round(baseH * scale));
      const offsetX = Math.round((nextW - baseW) / 2);
      const offsetY = Math.round((nextH - baseH) / 2);

      const canvas = document.createElement('canvas');
      canvas.width = nextW;
      canvas.height = nextH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建画布');
      ctx.clearRect(0, 0, nextW, nextH);
      ctx.drawImage(bitmap, offsetX, offsetY);
      const imageBase64 = canvas.toDataURL('image/png');

      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = nextW;
      maskCanvas.height = nextH;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) throw new Error('无法创建蒙版画布');
      maskCtx.fillStyle = 'white';
      maskCtx.fillRect(0, 0, nextW, nextH);
      maskCtx.fillStyle = 'black';
      maskCtx.fillRect(offsetX, offsetY, baseW, baseH);
      const maskBase64 = maskCanvas.toDataURL('image/png');

      bitmap.close?.();
      return { imageBase64, maskBase64 };
    },
    [loadImageAsBitmap]
  );

  const [actionDialog, setActionDialog] = useState<null | { kind: 'retouch' | 'outpaint'; itemId: string }>(null);
  const [retouchPrompt, setRetouchPrompt] = useState('');
  const [outpaintPrompt, setOutpaintPrompt] = useState('');
  const [outpaintPercent, setOutpaintPercent] = useState('130');
  const [layerActionBusy, setLayerActionBusy] = useState(false);
  const [layerActionError, setLayerActionError] = useState<string | null>(null);

  const runRetouch = useCallback(
    async (item: CanvasItem, prompt: string) => {
      if (!item.src) return;
      setLayerActionBusy(true);
      setLayerActionError(null);
      try {
        const url = await retouchImageFromUrl(item.src, prompt, { strength: 0.75 });
        const size = await loadImageSize(url);
        replaceCanvasImage(item.id, url, size.width, size.height);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLayerActionError(msg);
      } finally {
        setLayerActionBusy(false);
      }
    },
    [replaceCanvasImage]
  );

  const runOutpaint = useCallback(
    async (item: CanvasItem, prompt: string, percent: number) => {
      if (!item.src) return;
      setLayerActionBusy(true);
      setLayerActionError(null);
      try {
        const scale = clamp(percent, 101, 300) / 100;
        const { imageBase64, maskBase64 } = await buildOutpaintInputs(item.src, scale);
        const url = await retouchImageFromBase64(imageBase64, prompt, { mask: maskBase64 });
        const size = await loadImageSize(url);
        replaceCanvasImage(item.id, url, size.width, size.height);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLayerActionError(msg);
      } finally {
        setLayerActionBusy(false);
      }
    },
    [buildOutpaintInputs, replaceCanvasImage]
  );

  const runWatermarkRemoval = useCallback(
    async (item: CanvasItem) => {
      if (!item.src) return;
      setLayerActionBusy(true);
      setLayerActionError(null);
      try {
        const response = await fetch(item.src);
        if (!response.ok) throw new Error(`加载失败：${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const file = new File([blob], `layer_${item.id}.png`, { type: blob.type || 'image/png' });
        const url = await removeWatermark(file);
        const size = await loadImageSize(url);
        replaceCanvasImage(item.id, url, size.width, size.height);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLayerActionError(msg);
      } finally {
        setLayerActionBusy(false);
      }
    },
    [replaceCanvasImage]
  );

  const runUpscale = useCallback(
    async (item: CanvasItem, scale: number) => {
      if (!item.src) return;
      setLayerActionBusy(true);
      setLayerActionError(null);
      try {
        const response = await fetch(item.src);
        if (!response.ok) throw new Error(`加载失败：${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const file = new File([blob], `layer_${item.id}.png`, { type: blob.type || 'image/png' });
        const safeScale = scale === 4 ? 4 : 2;
        const url = await upscaleImage(file, 'real-esrgan', { ...DEFAULT_REAL_ESRGAN_PARAMS, scale: safeScale });
        const size = await loadImageSize(url);
        replaceCanvasImage(item.id, url, size.width, size.height);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLayerActionError(msg);
      } finally {
        setLayerActionBusy(false);
      }
    },
    [replaceCanvasImage]
  );

  const SelectField: React.FC<{
    label: string;
    value: string;
    options: string[];
    placeholder?: string;
    onChange: (value: string) => void;
  }> = ({ label, value, options, placeholder = '请选择', onChange }) => {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (!open) return;
      const onMouseDown = (e: MouseEvent) => {
        const el = rootRef.current;
        if (!el) return;
        if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
      };
      document.addEventListener('mousedown', onMouseDown);
      return () => document.removeEventListener('mousedown', onMouseDown);
    }, [open]);

    return (
      <div ref={rootRef} className="relative">
        <div className="text-xs font-semibold text-slate-700 mb-2">{label}</div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-slate-100/80 border border-slate-200 text-slate-800 text-sm font-semibold hover:bg-white transition-colors"
        >
          <span className={`${value ? 'text-slate-900' : 'text-slate-400'} truncate`}>{value || placeholder}</span>
          <ChevronDownIcon className={`w-5 h-5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="absolute left-0 right-0 mt-2 bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden z-50">
            <div className="max-h-[240px] overflow-y-auto custom-scrollbar p-2">
              {options.map((opt) => {
                const active = opt === value;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      onChange(opt);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-xl text-sm font-semibold transition-colors ${
                      active ? 'bg-blue-50 text-slate-900' : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const productInfoModal = isProductInfoOpen ? (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 md:pt-24 px-4" onClick={() => setIsProductInfoOpen(false)}>
      <div
        className="bg-white/90 border border-slate-200 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden backdrop-blur-sm flex flex-col max-h-[calc(100vh-8rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-200 bg-white/60">
          <div className="text-lg font-extrabold text-slate-900">商品信息</div>
          <button
            type="button"
            onClick={() => setIsProductInfoOpen(false)}
            className="text-slate-500 hover:text-slate-900 transition-colors p-1 hover:bg-slate-100 rounded-lg"
          >
            <XIcon className="w-6 h-6" />
          </button>
        </div>
        <div className="p-5 space-y-5 overflow-y-auto custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField label="电商平台" value={productForm.platform} options={PLATFORM_OPTIONS} onChange={setPlatform} />
            <SelectField label="销售国家/语言" value={productForm.market} options={MARKET_OPTIONS} onChange={setMarket} />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-xs font-semibold text-slate-700">商品列表</div>
              <button
                type="button"
                onClick={addProduct}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors"
              >
                <PlusIcon className="w-4 h-4" />
                <span>添加商品</span>
              </button>
            </div>

            <div className="space-y-3">
              {productForm.products.map((p) => {
                const selected = p.selected;
                return (
                  <div
                    key={p.id}
                    onClick={(e) => {
                      const target = e.target as HTMLElement | null;
                      if (!target) return;
                      if (target.closest('input, textarea, button')) return;
                      toggleProductSelected(p.id);
                    }}
                    className={`relative rounded-2xl border shadow-sm transition-colors ${
                      selected ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200 bg-white/70'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProductSelected(p.id);
                      }}
                      className="absolute top-3 left-3 w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors shadow-sm"
                      style={{
                        background: selected ? 'rgba(37, 99, 235, 0.95)' : 'rgba(255,255,255,0.95)',
                        borderColor: selected ? 'rgba(37, 99, 235, 0.95)' : 'rgba(148, 163, 184, 0.7)',
                        color: selected ? '#fff' : 'transparent'
                      }}
                      title={selected ? '取消选择' : '选择该商品'}
                    >
                      <CheckIcon className="w-4 h-4" />
                    </button>

                    {productForm.products.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeProduct(p.id);
                        }}
                        className="absolute top-3 right-3 p-2 rounded-xl text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="删除商品"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    )}

                    <div className="p-4 pl-12">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="md:col-span-1">
                          <div className="text-[11px] font-semibold text-slate-600 mb-1">商品名称</div>
                          <input
                            value={p.name}
                            onChange={(e) => updateProduct(p.id, { name: e.target.value })}
                            placeholder="请输入"
                            className="w-full px-3 py-2.5 rounded-xl bg-white/80 border border-slate-200 text-slate-900 text-sm font-semibold focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                        </div>
                        <div className="md:col-span-1">
                          <div className="text-[11px] font-semibold text-slate-600 mb-1">规格</div>
                          <input
                            value={p.spec}
                            onChange={(e) => updateProduct(p.id, { spec: e.target.value })}
                            placeholder="如：黑色/标准版/3.5mm"
                            className="w-full px-3 py-2.5 rounded-xl bg-white/80 border border-slate-200 text-slate-900 text-sm font-semibold focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                        </div>
                        <div className="md:col-span-1">
                          <div className="text-[11px] font-semibold text-slate-600 mb-1">价格</div>
                          <input
                            value={p.price}
                            onChange={(e) => updateProduct(p.id, { price: e.target.value })}
                            placeholder="如：¥199 / $29.99"
                            className="w-full px-3 py-2.5 rounded-xl bg-white/80 border border-slate-200 text-slate-900 text-sm font-semibold focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-slate-700 mb-2">商品详情（卖点/尺寸/场景）</div>
            <textarea
              value={productForm.details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="可输入商品相关详细信息，如商品卖点、尺寸规格、期望场景、适用人群等"
              className="w-full min-h-[140px] bg-slate-100/80 border border-slate-200 rounded-2xl resize-none text-slate-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 p-4 custom-scrollbar"
            />
          </div>

          <div>
            <div className="text-xs font-semibold text-slate-700 mb-2">最终输入预览</div>
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs text-slate-700 whitespace-pre-wrap min-h-[96px] custom-scrollbar overflow-y-auto">
              {composedInputPreview || '填写商品信息，或在首页输入补充需求后，将在这里实时合成最终输入内容。'}
            </div>
          </div>
        </div>

        <div className="p-5 pt-0">
          <button
            type="button"
            onClick={() => setIsProductInfoOpen(false)}
            className="w-full px-4 py-3 rounded-2xl bg-blue-500/70 text-white text-sm font-extrabold hover:bg-blue-600/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!hasProductInfo}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (stage === 'init') {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="w-full max-w-4xl px-6">
          <div className="bg-white/80 border border-slate-200 rounded-3xl shadow-xl backdrop-blur-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500/50 via-fuchsia-500/40 to-transparent"></div>

            <div className="p-8">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 rounded-2xl bg-blue-50 text-blue-700 border border-blue-100">
                  <HomeIcon className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <div className="text-xl font-extrabold text-slate-900">量子AI设计</div>
                  <div className="text-sm text-slate-600">上传素材，描述需求，发送后进入画布工作台。</div>
                </div>
              </div>

              <div className="relative">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="例如：帮我生成一套淘宝套图，售卖到中国，中文，这是电竞耳机，卖点是极致降噪，高清音质。"
                  className="w-full min-h-[220px] bg-white border border-slate-200 rounded-2xl resize-none text-slate-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 p-4 pl-14 custom-scrollbar"
                />

                <div className="absolute top-4 left-4">
                  <button
                    type="button"
                    title="上传图片"
                    className="inline-flex items-center justify-center w-10 h-10 rounded-2xl bg-white border border-slate-200 text-slate-700 shadow-sm cursor-pointer hover:bg-slate-50 transition-colors"
                    onClick={openUpload}
                  >
                    <PlusIcon className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {isUploadOpen && (
                <div
                  className="mt-4 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden"
                  onDragEnter={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsUploadDragOver(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsUploadDragOver(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsUploadDragOver(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsUploadDragOver(false);
                    const files = Array.from(e.dataTransfer.files || []);
                    void handleUploadFiles(files);
                  }}
                >
                  <div className="px-4 py-3 border-b border-slate-200 bg-white/60 flex items-center justify-between gap-3">
                    <div className="text-xs font-extrabold text-slate-900">上传文件/图片</div>
                    <button type="button" onClick={closeUpload} className="p-2 rounded-xl hover:bg-slate-100 text-slate-600">
                      <XIcon className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="p-4">
                    <div
                      className={`rounded-2xl border-2 border-dashed transition-colors ${
                        isUploadDragOver ? 'border-blue-400 bg-blue-50/40' : 'border-slate-200 bg-slate-50/40'
                      } ${pendingImages.length > 0 || pendingFiles.length > 0 ? 'p-4' : 'px-4 py-10 text-center'}`}
                      onClick={() => uploadInputRef.current?.click()}
                    >
                      {pendingImages.length === 0 && pendingFiles.length === 0 ? (
                        <div className="flex flex-col items-center gap-2">
                          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white border border-slate-200 shadow-sm text-slate-700">
                            <PlusIcon className="w-7 h-7" />
                          </div>
                          <div className="text-sm font-extrabold text-slate-900">拖拽文件/图片到这里</div>
                          <div className="text-xs text-slate-600">或点击“+”选择多文件上传</div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                          {pendingImagePreviews.map((p) => (
                            <div key={p.key} className="relative aspect-square rounded-2xl overflow-hidden border border-slate-200 bg-white shadow-sm">
                              <img src={p.url} className="w-full h-full object-cover" draggable={false} />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingImages((prev) => prev.filter((_, i) => i !== p.idx));
                                }}
                                className="absolute top-1 right-1 p-1 rounded-lg bg-white/90 border border-slate-200 text-slate-600 hover:bg-white transition-colors"
                                title="移除"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                          ))}

                          {pendingFiles.map((f, idx) => (
                            <div
                              key={`${f.name}-${f.size}-${f.lastModified}-${idx}`}
                              className="relative aspect-square rounded-2xl border border-slate-200 bg-white shadow-sm flex items-center justify-center p-2"
                            >
                              <div className="text-[10px] font-bold text-slate-700 text-center break-all line-clamp-4">{f.name}</div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
                                }}
                                className="absolute top-1 right-1 p-1 rounded-lg bg-white/90 border border-slate-200 text-slate-600 hover:bg-white transition-colors"
                                title="移除"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                          ))}

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              uploadInputRef.current?.click();
                            }}
                            className="aspect-square rounded-2xl border-2 border-dashed border-slate-200 bg-white/70 hover:bg-white transition-colors flex items-center justify-center text-slate-600"
                            title="继续添加"
                          >
                            <PlusIcon className="w-7 h-7" />
                          </button>
                        </div>
                      )}
                    </div>

                    <input
                      ref={uploadInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = e.target.files ? Array.from(e.target.files) : [];
                        void handleUploadFiles(files);
                        e.currentTarget.value = '';
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={openUpload}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold shadow-sm hover:bg-slate-50 transition-colors"
                  >
                    <UploadIcon className="w-4 h-4" />
                    <span>上传文件</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsProductInfoOpen(true)}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold shadow-sm hover:bg-slate-50 transition-colors"
                  >
                    <PlusIcon className="w-4 h-4" />
                    <span>商品信息</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleSendFromInit}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-extrabold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!draft.trim() && pendingImages.length === 0 && pendingFiles.length === 0 && !hasProductInfo}
                >
                  <span>发送</span>
                </button>
              </div>

              {(pendingImages.length > 0 || pendingFiles.length > 0 || hasProductInfo) && (
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  {pendingImages.length > 0 && <span className="px-2 py-1 rounded-full bg-blue-50 border border-blue-100">已选图片 {pendingImages.length}</span>}
                  {pendingFiles.length > 0 && <span className="px-2 py-1 rounded-full bg-slate-50 border border-slate-200">已选文件 {pendingFiles.length}</span>}
                  {hasProductInfo && <span className="px-2 py-1 rounded-full bg-fuchsia-50 border border-fuchsia-100">已填写商品信息</span>}
                </div>
              )}

              {(hasProductInfo || draft.trim()) && (
                <div className="mt-4 bg-white border border-slate-200 rounded-2xl p-4 text-xs text-slate-700 whitespace-pre-wrap custom-scrollbar overflow-y-auto max-h-[140px]">
                  {composedInputPreview}
                </div>
              )}
            </div>
          </div>
        </div>

        {productInfoModal}
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden" style={{ height: '100vh' }} onPointerMove={onPanelPointerMove} onPointerUp={onPanelPointerUp}>
      <div className="h-[56px] w-full flex items-center px-4 gap-3 bg-white/80 border-b border-slate-200 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0 shrink-0">
          <div className="p-2 rounded-xl bg-blue-50 text-blue-700 border border-blue-100">
            <HomeIcon className="w-5 h-5" />
          </div>
          <div className="font-extrabold text-slate-900 truncate">工作台</div>
          <div className="hidden md:block text-xs text-slate-500 truncate">画布</div>
        </div>

        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-px h-6 bg-slate-200" />
          <div className="flex items-center gap-2 min-w-0 overflow-x-auto custom-scrollbar">
            {openSessionIds.length === 0 ? (
              <div className="text-xs text-slate-500 whitespace-nowrap">暂无会话</div>
            ) : (
              openSessionIds.map((id) => {
                const s = sessionById.get(id);
                if (!s) return null;
                const active = id === activeSessionId;
                return (
                  <div
                    key={id}
                    className={`inline-flex items-center rounded-xl border shadow-sm shrink-0 ${
                      active ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveSessionId(id)}
                      className="px-3 py-1.5 text-xs font-bold text-slate-800 max-w-[180px] truncate"
                      title={s.title}
                    >
                      {s.title || '会话'}
                    </button>
                    <button
                      type="button"
                      onClick={() => closeSessionWindow(id)}
                      className="px-2 py-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-r-xl transition-colors"
                      title="关闭会话窗口"
                      aria-label="关闭会话窗口"
                    >
                      <XIcon className="w-4 h-4" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="w-px h-6 bg-slate-200" />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setStage('init')}
            className="px-3 py-2 rounded-xl bg-white/80 border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors"
          >
            返回
          </button>
          <button
            type="button"
            onClick={() => {
              if (activeSessionId) closeSessionWindow(activeSessionId);
            }}
            disabled={!activeSessionId}
            className="px-3 py-2 rounded-xl bg-white/80 border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            关闭会话
          </button>
          <button
            type="button"
            onClick={createNewSession}
            className="px-3 py-2 rounded-xl bg-white/80 border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors"
          >
            新会话
          </button>
          <button
            type="button"
            onClick={() => setIsHistoryOpen(true)}
            className="px-3 py-2 rounded-xl bg-white/80 border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors"
          >
            历史记录
          </button>
          <button
            type="button"
            onClick={() => setPanelCollapsed((v) => !v)}
            className="px-3 py-2 rounded-xl bg-white/80 border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 transition-colors"
          >
            {panelCollapsed ? '展开' : '收起'}
          </button>

          <button
            type="button"
            onClick={handleDownloadSelection}
            disabled={downloadableSelectedCount === 0}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-extrabold shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="下载选中内容"
          >
            <DownloadIcon className="w-4 h-4" />
            <span>下载</span>
          </button>
        </div>
      </div>

      <div className="relative w-full" style={{ height: 'calc(100% - 56px)' }}>
        <div
          ref={canvasRef}
          className="absolute inset-0 ql-canvas-grid overflow-hidden"
          onPointerDown={onCanvasBackgroundPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerEnter={() => {
            canvasHoveredRef.current = true;
          }}
          onPointerLeave={() => {
            canvasHoveredRef.current = false;
          }}
          onWheel={onCanvasWheel}
          style={{
            backgroundPosition: `${present.panX}px ${present.panY}px`,
            backgroundSize: `${24 * present.zoom}px ${24 * present.zoom}px`
          }}
        >
          <div className="absolute inset-0" style={{ transform: `translate(${present.panX}px, ${present.panY}px)` }}>
            <div className="absolute inset-0" style={{ transform: `scale(${present.zoom})`, transformOrigin: '0 0' }}>
              {present.items.map((it, idx) => {
                if (it.visible === false) return null;
                const selected = selectedIds.has(it.id);
                const opacity = typeof it.opacity === 'number' ? it.opacity : 1;
                return (
                  <div
                    key={it.id}
                    className={`absolute ${selected ? 'ring-2 ring-blue-500' : ''} rounded-lg`}
                    style={{ left: it.x, top: it.y, width: it.width, height: it.height, zIndex: present.items.length - idx, opacity }}
                    onPointerDown={(e) => onItemPointerDown(e, it.id)}
                  >
                    {it.type === 'image' && it.src && (
                      <img src={it.src} draggable={false} className="w-full h-full object-contain bg-white rounded-lg shadow-sm border border-slate-200" />
                    )}
                    {it.type === 'video' && it.src && (
                      <video src={it.src} className="w-full h-full object-contain bg-white rounded-lg shadow-sm border border-slate-200" controls={false} />
                    )}
                    {it.type === 'text' && (
                      <div className="w-full h-full bg-white/90 rounded-lg shadow-sm border border-slate-200 px-4 flex items-center text-slate-900 font-bold">
                        {it.text}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 bg-white/90 border border-slate-200 rounded-2xl shadow-2xl px-4 py-2 flex items-center gap-2 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setToolMode('select')}
            className={`w-10 h-10 inline-flex items-center justify-center rounded-2xl text-xs font-extrabold border transition-colors ${
              toolMode === 'select' ? 'bg-blue-600 text-white border-blue-500' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
            title="选择"
            aria-label="选择"
          >
            <CursorIcon className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => setToolMode('pan')}
            className={`w-10 h-10 inline-flex items-center justify-center rounded-2xl text-xs font-extrabold border transition-colors ${
              toolMode === 'pan' ? 'bg-blue-600 text-white border-blue-500' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
            title="移动画布（按住 Space 临时切换）"
            aria-label="移动画布"
          >
            <HandIcon className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={handleAddText}
            className="w-10 h-10 inline-flex items-center justify-center rounded-2xl text-xs font-extrabold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 transition-colors"
            title="添加文字"
            aria-label="添加文字"
          >
            <TextIcon className="w-5 h-5" />
          </button>
          <label
            className="w-10 h-10 inline-flex items-center justify-center rounded-2xl text-xs font-extrabold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 transition-colors cursor-pointer"
            title="导入"
            aria-label="导入"
          >
            <UploadIcon className="w-5 h-5" />
            <input
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (files) void importAssets(files);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <button
            type="button"
            onClick={undo}
            className="w-10 h-10 inline-flex items-center justify-center rounded-2xl text-xs font-extrabold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 transition-colors"
            title="撤销"
            aria-label="撤销"
          >
            <UndoIcon className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={redo}
            className="w-10 h-10 inline-flex items-center justify-center rounded-2xl text-xs font-extrabold border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 transition-colors"
            title="重做"
            aria-label="重做"
          >
            <RedoIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="absolute bottom-4 right-4 z-20 bg-white/90 border border-slate-200 rounded-2xl shadow-2xl px-3 py-2 flex items-center gap-2 backdrop-blur-sm">
          <button
            type="button"
            onClick={() => zoomAtCanvasCenter((present.zoom || 1) * 0.9)}
            className="w-10 h-10 inline-flex items-center justify-center rounded-2xl border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 transition-colors"
            title="缩小"
            aria-label="缩小"
          >
            <ZoomOutIcon className="w-5 h-5" />
          </button>
          <input
            value={zoomInput}
            onChange={onZoomInputChange}
            onFocus={() => {
              zoomEditingRef.current = true;
            }}
            onBlur={commitZoomInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitZoomInput();
              if (e.key === 'Escape') {
                zoomEditingRef.current = false;
                setZoomInput(String(Math.round((present.zoom || 1) * 100)));
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className="w-20 h-10 px-3 rounded-2xl border border-slate-200 bg-white text-slate-800 text-sm font-extrabold text-center focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            inputMode="decimal"
            aria-label="画布缩放比例"
          />
          <button
            type="button"
            onClick={() => zoomAtCanvasCenter((present.zoom || 1) * 1.1)}
            className="w-10 h-10 inline-flex items-center justify-center rounded-2xl border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 transition-colors"
            title="放大"
            aria-label="放大"
          >
            <ZoomInIcon className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={fitToContent}
            className="w-10 h-10 inline-flex items-center justify-center rounded-2xl border bg-white text-slate-700 border-slate-200 hover:bg-slate-50 transition-colors"
            title="显示全部"
            aria-label="显示全部"
          >
            <FitViewIcon className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => setIsLayersOpen((v) => !v)}
            className={`w-10 h-10 inline-flex items-center justify-center rounded-2xl border transition-colors ${
              isLayersOpen ? 'bg-blue-600 text-white border-blue-500' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
            title="图层"
            aria-label="图层"
          >
            <LayersIcon className="w-5 h-5" />
          </button>
        </div>

        {isLayersOpen && (
          <div
            data-ql-layers-panel="1"
            className="absolute z-30 bottom-20 right-4 w-[320px] bg-white/90 border border-slate-200 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-sm"
          >
            <div className="px-4 py-3 border-b border-slate-200 bg-white/60 flex items-center justify-between gap-3">
              <div className="text-sm font-extrabold text-slate-900">图层管理</div>
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold text-slate-600">不透明度</div>
                <input
                  value={opacityInput}
                  onChange={(e) => {
                    opacityEditingRef.current = true;
                    setOpacityInput(e.target.value.replace(/[^\d.]/g, ''));
                  }}
                  onFocus={() => {
                    opacityEditingRef.current = true;
                  }}
                  onBlur={commitOpacityInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitOpacityInput();
                    if (e.key === 'Escape') {
                      opacityEditingRef.current = false;
                      setOpacityInput(String(Math.round((singleSelectedItem?.opacity ?? 1) * 100)));
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  onPointerDown={startOpacityDrag}
                  disabled={!singleSelectedId}
                  className="w-16 h-9 px-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-xs font-extrabold text-center focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                  inputMode="decimal"
                  aria-label="不透明度百分比"
                />
              </div>
            </div>
            <div className="max-h-[320px] overflow-y-auto custom-scrollbar p-3 space-y-2">
              {present.items.map((it) => {
                const selected = selectedIds.has(it.id);
                const label = it.type === 'image' ? '图片' : it.type === 'video' ? '视频' : '文字';
                return (
                  <div
                    key={it.id}
                    data-ql-layer-row="1"
                    data-layer-id={it.id}
                    onClick={(e) => {
                      const target = e.target as HTMLElement | null;
                      if (!target) return;
                      if (target.closest('button')) return;
                      setSelectedIds(new Set([it.id]));
                    }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-2xl border shadow-sm transition-colors ${
                      selected ? 'bg-blue-50 border-blue-200' : 'bg-white/70 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div
                      onPointerDown={(e) => startLayerReorder(e, it.id)}
                      className="w-2 h-8 rounded-full bg-slate-200 hover:bg-slate-300 cursor-grab active:cursor-grabbing"
                      title="拖拽排序"
                      aria-label="拖拽排序"
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleLayerVisible(it.id);
                      }}
                      className="w-8 h-8 inline-flex items-center justify-center rounded-xl hover:bg-slate-100 text-slate-600 transition-colors"
                      title={it.visible === false ? '显示' : '隐藏'}
                      aria-label={it.visible === false ? '显示' : '隐藏'}
                    >
                      {it.visible === false ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-extrabold text-slate-800 truncate">{label}</div>
                      <div className="text-[11px] text-slate-500 truncate">{it.id}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isActionsDockOpen && singleSelectedItem && (
          <div className="absolute z-30 bottom-20 right-[360px] w-[260px] bg-white/90 border border-slate-200 rounded-2xl shadow-2xl p-3 backdrop-blur-sm">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setActionDialog({ kind: 'retouch', itemId: singleSelectedItem.id });
                  setRetouchPrompt('');
                  setLayerActionError(null);
                }}
                disabled={layerActionBusy || singleSelectedItem.type !== 'image' || !singleSelectedItem.src}
                className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-xs font-extrabold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                AI改图
              </button>
              <button
                type="button"
                onClick={() => {
                  setActionDialog({ kind: 'outpaint', itemId: singleSelectedItem.id });
                  setOutpaintPrompt('');
                  setOutpaintPercent('130');
                  setLayerActionError(null);
                }}
                disabled={layerActionBusy || singleSelectedItem.type !== 'image' || !singleSelectedItem.src}
                className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-xs font-extrabold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                AI扩图
              </button>
              <button
                type="button"
                onClick={() => void runWatermarkRemoval(singleSelectedItem)}
                disabled={layerActionBusy || singleSelectedItem.type !== 'image' || !singleSelectedItem.src}
                className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-xs font-extrabold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                AI去水印
              </button>
              <button
                type="button"
                onClick={() => void runUpscale(singleSelectedItem, 2)}
                disabled={layerActionBusy || singleSelectedItem.type !== 'image' || !singleSelectedItem.src}
                className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-xs font-extrabold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                AI放大×2
              </button>
              <button
                type="button"
                onClick={() => addCanvasItemToChat(singleSelectedItem)}
                disabled={layerActionBusy}
                className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-xs font-extrabold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                发到对话
              </button>
              <button
                type="button"
                onClick={() => void downloadCanvasItem(singleSelectedItem)}
                disabled={layerActionBusy || (singleSelectedItem.type !== 'image' && singleSelectedItem.type !== 'video') || !singleSelectedItem.src}
                className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-800 text-xs font-extrabold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                下载
              </button>
              <button
                type="button"
                onClick={deleteSelectedCanvasItems}
                disabled={layerActionBusy}
                className="col-span-2 px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 text-xs font-extrabold hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                删除图层
              </button>
            </div>
            {layerActionError && <div className="mt-2 text-[11px] font-semibold text-red-600 break-words">{layerActionError}</div>}
          </div>
        )}

        {actionDialog && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4"
            onClick={() => {
              if (layerActionBusy) return;
              setActionDialog(null);
            }}
          >
            <div
              className="w-full max-w-xl bg-white/90 border border-slate-200 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-sm"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b border-slate-200 bg-white/60 flex items-center justify-between gap-3">
                <div className="text-sm font-extrabold text-slate-900">{actionDialog.kind === 'retouch' ? 'AI改图' : 'AI扩图'}</div>
                <button
                  type="button"
                  onClick={() => setActionDialog(null)}
                  disabled={layerActionBusy}
                  className="p-2 rounded-xl hover:bg-slate-100 text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="关闭"
                  title="关闭"
                >
                  <XIcon className="w-5 h-5" />
                </button>
              </div>
              <div className="p-5 space-y-3">
                {actionDialog.kind === 'outpaint' && (
                  <div className="flex items-center gap-3">
                    <div className="text-xs font-semibold text-slate-700 w-20">扩图比例</div>
                    <input
                      value={outpaintPercent}
                      onChange={(e) => setOutpaintPercent(e.target.value.replace(/[^\d.]/g, ''))}
                      className="w-24 px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-800 text-sm font-bold focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      inputMode="decimal"
                    />
                    <div className="text-xs text-slate-500">%</div>
                  </div>
                )}
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-2">指令</div>
                  <textarea
                    value={actionDialog.kind === 'retouch' ? retouchPrompt : outpaintPrompt}
                    onChange={(e) => (actionDialog.kind === 'retouch' ? setRetouchPrompt(e.target.value) : setOutpaintPrompt(e.target.value))}
                    placeholder={actionDialog.kind === 'retouch' ? '例如：把背景换成纯白，并提升清晰度' : '例如：向四周自然延展背景，保持风格一致'}
                    className="w-full min-h-[120px] bg-white/80 border border-slate-200 rounded-2xl resize-none text-slate-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 p-4 custom-scrollbar"
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setActionDialog(null)}
                    disabled={layerActionBusy}
                    className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const it = present.items.find((x) => x.id === actionDialog.itemId) || null;
                      if (!it || it.type !== 'image' || !it.src) return;
                      if (actionDialog.kind === 'retouch') {
                        const prompt = retouchPrompt.trim();
                        if (!prompt) return;
                        void runRetouch(it, prompt);
                        setActionDialog(null);
                        return;
                      }
                      const prompt = outpaintPrompt.trim();
                      if (!prompt) return;
                      const pct = Number(outpaintPercent);
                      if (!Number.isFinite(pct)) return;
                      void runOutpaint(it, prompt, pct);
                      setActionDialog(null);
                    }}
                    disabled={layerActionBusy}
                    className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-extrabold hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {layerActionBusy ? '处理中...' : '执行'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {panelCollapsed ? (
          <button
            type="button"
            onClick={() => setPanelCollapsed(false)}
            className="absolute z-30 left-4 top-4 px-4 py-2 rounded-2xl bg-white/90 border border-slate-200 shadow-2xl text-xs font-extrabold text-slate-700 hover:bg-slate-50 backdrop-blur-sm"
          >
            打开对话栏
          </button>
        ) : (
          <div
            className="absolute z-30 left-0 top-0 bg-white/90 border border-slate-200 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-sm"
            style={{ width: panelWidth, height: panelOuterHeight }}
          >
            <div className="relative w-full h-full flex flex-col min-w-0">
              <div
                className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize bg-transparent hover:bg-blue-500/10 transition-colors"
                onPointerDown={startWidthDrag}
                title="拖拽调整宽度"
              />
              <div
                className="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize bg-transparent hover:bg-blue-500/10 transition-colors"
                onPointerDown={startHeightDrag}
                title="拖拽调整高度"
              />
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2 bg-white/60">
                <div className="font-extrabold text-slate-900 text-sm truncate">量子跃迁AI修图工作室 · AI 对话</div>
                <button
                  type="button"
                  onClick={() => setPanelCollapsed(true)}
                  className="px-2 py-1 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  收起
                </button>
              </div>

              <div ref={chatScrollRef} className="flex-1 min-h-0 px-4 py-3 overflow-y-auto custom-scrollbar">
                <div className="space-y-3">
                  {(activeSession?.messages || []).map((m) => (
                    <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed border shadow-sm ${
                          m.role === 'user'
                            ? 'bg-blue-600 text-white border-blue-500'
                            : 'bg-white text-slate-800 border-slate-200'
                        } ${chatContextMenu?.messageId === m.id ? 'ring-2 ring-blue-400' : ''}`}
                        ref={(el) => {
                          if (el) chatMessageElMapRef.current.set(m.id, el);
                          else chatMessageElMapRef.current.delete(m.id);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const el = chatMessageElMapRef.current.get(m.id);
                          if (el) {
                            const sel = window.getSelection();
                            if (sel) {
                              sel.removeAllRanges();
                              const range = document.createRange();
                              range.selectNodeContents(el);
                              sel.addRange(range);
                            }
                          }

                          const menuWidth = 168;
                          const menuHeight = 140;
                          const x = clamp(e.clientX, 8, Math.max(8, window.innerWidth - menuWidth - 8));
                          const y = clamp(e.clientY, 8, Math.max(8, window.innerHeight - menuHeight - 8));

                          setChatContextMenu({ x, y, messageId: m.id, content: m.content, pasteText: '' });

                          void (async () => {
                            try {
                              const text = await navigator.clipboard.readText();
                              setChatContextMenu((prev) => {
                                if (!prev) return prev;
                                if (prev.messageId !== m.id) return prev;
                                return { ...prev, pasteText: text || '' };
                              });
                            } catch {
                            }
                          })();
                        }}
                      >
                        {m.content}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div
                className="h-2 cursor-ns-resize border-t border-slate-200 bg-transparent hover:bg-blue-500/10 transition-colors"
                onPointerDown={startComposerHeightDrag}
                title="拖拽调整对话输入区高度"
              />

              <div className="p-3 bg-white/60 flex flex-col gap-2 min-h-0" style={{ height: chatComposerHeight }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setIsWorkbenchImageUploadOpen((v) => !v);
                        setIsWorkbenchFileUploadOpen(false);
                      }}
                      className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-white border border-slate-200 text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
                      title="上传图片"
                      aria-label="上传图片"
                    >
                      <PlusIcon className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsWorkbenchFileUploadOpen((v) => !v);
                        setIsWorkbenchImageUploadOpen(false);
                      }}
                      className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-white border border-slate-200 text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
                      title="上传文件"
                      aria-label="上传文件"
                    >
                      <UploadIcon className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsProductInfoOpen(true)}
                      className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-white border border-slate-200 text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
                      title="商品信息"
                      aria-label="商品信息"
                    >
                      <TextIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {(isWorkbenchImageUploadOpen || isWorkbenchFileUploadOpen) && (
                  <div className="grid grid-cols-1 gap-2">
                    {isWorkbenchImageUploadOpen && (
                      <div
                        className={`rounded-xl border-2 border-dashed px-3 py-3 text-xs text-slate-700 transition-colors ${
                          isWorkbenchImageDragOver ? 'border-blue-400 bg-blue-50/50' : 'border-slate-200 bg-white/70'
                        }`}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchImageDragOver(true);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchImageDragOver(true);
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchImageDragOver(false);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchImageDragOver(false);
                          const dropped = Array.from(e.dataTransfer.files || []) as File[];
                          const files = dropped.filter((f) => f.type.startsWith('image/'));
                          if (files.length > 0) void importAssets(files);
                        }}
                        onClick={() => workbenchImageInputRef.current?.click()}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="font-bold text-slate-900">拖拽图片到这里</div>
                        <div className="text-slate-600 mt-0.5">或点击选择图片（将直接载入画布）</div>
                        <input
                          ref={workbenchImageInputRef}
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const files = e.target.files ? Array.from(e.target.files) : [];
                            if (files.length > 0) void importAssets(files);
                            e.currentTarget.value = '';
                          }}
                        />
                      </div>
                    )}

                    {isWorkbenchFileUploadOpen && (
                      <div
                        className={`rounded-xl border-2 border-dashed px-3 py-3 text-xs text-slate-700 transition-colors ${
                          isWorkbenchFileDragOver ? 'border-blue-400 bg-blue-50/50' : 'border-slate-200 bg-white/70'
                        }`}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchFileDragOver(true);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchFileDragOver(true);
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchFileDragOver(false);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsWorkbenchFileDragOver(false);
                          const files = Array.from(e.dataTransfer.files || []);
                          if (files.length > 0) void handleUploadFiles(files);
                        }}
                        onClick={() => workbenchFileInputRef.current?.click()}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="font-bold text-slate-900">拖拽文件到这里</div>
                        <div className="text-slate-600 mt-0.5">或点击选择文件</div>
                        <input
                          ref={workbenchFileInputRef}
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const files = e.target.files ? Array.from(e.target.files) : [];
                            if (files.length > 0) void handleUploadFiles(files);
                            e.currentTarget.value = '';
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-end gap-2 mt-auto">
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="输入需求，或继续补充信息..."
                    ref={chatTextareaRef}
                    disabled={isWorkbenchAiRunning}
                    className="flex-1 min-h-[72px] max-h-[140px] bg-white/80 border border-slate-200 rounded-xl resize-none text-slate-800 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400 p-3 custom-scrollbar"
                  />
                  <button
                    type="button"
                    onClick={isWorkbenchAiRunning ? cancelWorkbenchAi : handleSendInWorkbench}
                    className={`px-4 py-2 rounded-xl text-white text-sm font-extrabold transition-colors ${
                      isWorkbenchAiRunning ? 'bg-slate-700 hover:bg-slate-800' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                    title={isWorkbenchAiRunning ? '取消生成' : '发送'}
                  >
                    {isWorkbenchAiRunning ? <RedoIcon className="w-4 h-4 animate-spin" /> : '发送'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {chatContextMenu && (
        <div className="fixed inset-0 z-[60]" onMouseDown={closeChatContextMenu}>
          <div
            className="absolute bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden"
            style={{ left: chatContextMenu.x, top: chatContextMenu.y, width: 168 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm font-bold text-slate-800 hover:bg-slate-50 transition-colors"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(chatContextMenu.content);
                  } catch {
                  } finally {
                    closeChatContextMenu();
                  }
                })();
              }}
            >
              复制
            </button>

            {chatContextMenu.pasteText.trim().length > 0 && (
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm font-bold text-slate-800 hover:bg-slate-50 transition-colors"
                onClick={() => {
                  const pasted = chatContextMenu.pasteText;
                  setChatInput((prev) => (prev.trim().length > 0 ? `${prev}\n${pasted}` : pasted));
                  closeChatContextMenu();
                  window.setTimeout(() => chatTextareaRef.current?.focus(), 0);
                }}
              >
                粘贴
              </button>
            )}

            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm font-bold text-slate-800 hover:bg-slate-50 transition-colors"
              onClick={() => {
                const quoted = `【引用】\n${chatContextMenu.content}`.trim();
                setChatInput((prev) => (prev.trim().length > 0 ? `${prev}\n${quoted}` : quoted));
                closeChatContextMenu();
                window.setTimeout(() => chatTextareaRef.current?.focus(), 0);
              }}
            >
              引用
            </button>
          </div>
        </div>
      )}

      {isHistoryOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4" onClick={() => setIsHistoryOpen(false)}>
          <div className="bg-white/90 border border-slate-200 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-200 bg-white/60">
              <div className="text-lg font-extrabold text-slate-900">历史记录</div>
              <button
                type="button"
                onClick={() => setIsHistoryOpen(false)}
                className="text-slate-500 hover:text-slate-900 transition-colors p-1 hover:bg-slate-100 rounded-lg"
              >
                <XIcon className="w-6 h-6" />
              </button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
              <div className="space-y-2">
                {sessions.length === 0 ? (
                  <div className="text-slate-600 text-sm text-center py-10">暂无会话</div>
                ) : (
                  sessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        openSessionWindow(s.id);
                        setIsHistoryOpen(false);
                      }}
                      className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${
                        s.id === activeSessionId ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-bold text-slate-900 truncate">{s.title}</div>
                        <div className="text-xs text-slate-500">{new Date(s.createdAt).toLocaleString()}</div>
                      </div>
                      <div className="text-xs text-slate-600 truncate mt-1">
                        {(s.messages[s.messages.length - 1]?.content || '').slice(0, 80)}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {productInfoModal}
    </div>
  );
};
