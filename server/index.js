import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images

const DATA_DIR = path.join(__dirname, '../data');
console.log('Data directory path:', DATA_DIR);

// Helper to get user directory
const getUserDir = (userId) => path.join(DATA_DIR, userId);
const getUserImagesDir = (userId) => path.join(DATA_DIR, userId, 'images');
const getUserKnowledgeFile = (userId) => path.join(DATA_DIR, userId, 'knowledge.json');

// Ensure data directory exists
fs.ensureDirSync(DATA_DIR);

// Middleware to validate userId
const validateUserId = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ error: 'Missing x-user-id header' });
  }
  // Basic validation to prevent path traversal
  if (!/^[a-zA-Z0-9-]+$/.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId format' });
  }
  req.userId = userId;
  next();
};

// GET /api/knowledge
app.get('/api/knowledge', validateUserId, async (req, res) => {
  try {
    const knowledgeFile = getUserKnowledgeFile(req.userId);
    if (await fs.pathExists(knowledgeFile)) {
      const data = await fs.readJson(knowledgeFile);
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error('Error reading knowledge base:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge
app.post('/api/knowledge', validateUserId, async (req, res) => {
  try {
    const entries = req.body;
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: 'Expected an array of entries' });
    }

    const imagesDir = getUserImagesDir(req.userId);
    await fs.ensureDir(imagesDir);

    // Process entries: extract base64 images and save as files
    const processedEntries = await Promise.all(entries.map(async (entry) => {
      if (entry.sourceImagePreview && entry.sourceImagePreview.startsWith('data:image')) {
        // Extract base64 data
        const matches = entry.sourceImagePreview.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1];
          const data = matches[2];
          const filename = `${uuidv4()}.${ext}`;
          const filePath = path.join(imagesDir, filename);
          
          await fs.writeFile(filePath, data, 'base64');
          
          // Update entry with URL
          return {
            ...entry,
            sourceImagePreview: `/api/images/${req.userId}/${filename}`
          };
        }
      }
      return entry;
    }));

    // Save updated JSON
    const knowledgeFile = getUserKnowledgeFile(req.userId);
    await fs.ensureDir(path.dirname(knowledgeFile));
    await fs.writeJson(knowledgeFile, processedEntries, { spaces: 2 });

    res.json(processedEntries);
  } catch (error) {
    console.error('Error saving knowledge base:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve user images
app.get('/api/images/:userId/:filename', async (req, res) => {
  const { userId, filename } = req.params;
  
  // Security check
  if (!/^[a-zA-Z0-9-]+$/.test(userId) || !/^[a-zA-Z0-9-.]+$/.test(filename)) {
    return res.status(400).send('Invalid parameters');
  }

  const filePath = path.join(getUserImagesDir(userId), filename);
  
  if (await fs.pathExists(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Image not found');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
